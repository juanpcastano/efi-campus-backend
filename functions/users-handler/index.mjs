import { Router } from "aws-lambda-router";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.USER_POOL_ID;
const USERS_TABLE = process.env.USERS_TABLE ?? "efi-campus-users";

// ─── Helpers ────────────────────────────────────────────────────────────────

const ok = (body, status = 200) => ({
  statusCode: status,
  body: JSON.stringify(body),
});

const err = (message, status = 400) => ({
  statusCode: status,
  body: JSON.stringify({ message }),
});

/** Extracts the sub from the JWT claims injected by API Gateway */
const getSub = (event) => event.requestContext?.authorizer?.jwt?.claims?.sub;

const getUser = async (id) => {
  const res = await dynamo.send(
    new GetItemCommand({ TableName: USERS_TABLE, Key: marshall({ id }) }),
  );
  return res.Item ? unmarshall(res.Item) : null;
};

/** Fetches the caller's user record and checks if role === "admin" */
const isAdmin = async (event) => {
  const sub = getSub(event);
  if (!sub) return false;
  const user = await getUser(sub);
  return user?.role === "admin";
};

// ─── Router ─────────────────────────────────────────────────────────────────

const router = new Router();

// ── GET /users ───────────────────────────────────────────────────────────────
router.get("/users", async (event) => {
  if (!(await isAdmin(event))) return err("Forbidden", 403);

  const { role, search } = event.queryStringParameters ?? {};

  // Full scan — pagination can be added later
  const params = { TableName: USERS_TABLE };

  const filterExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};

  if (role) {
    filterExpressions.push("#role = :role");
    expressionAttributeNames["#role"] = "role";
    expressionAttributeValues[":role"] = { S: role };
  }

  if (search) {
    const s = search.toLowerCase();
    filterExpressions.push(
      "(contains(#fn, :search) OR contains(#ln, :search) OR contains(#email, :search))",
    );
    expressionAttributeNames["#fn"] = "firstName";
    expressionAttributeNames["#ln"] = "lastName";
    expressionAttributeNames["#email"] = "email";
    expressionAttributeValues[":search"] = { S: s };
  }

  if (filterExpressions.length) {
    params.FilterExpression = filterExpressions.join(" AND ");
    params.ExpressionAttributeNames = expressionAttributeNames;
    params.ExpressionAttributeValues = expressionAttributeValues;
  }

  const res = await dynamo.send(new ScanCommand(params));
  return ok({ users: (res.Items ?? []).map(unmarshall) });
});

// ── GET /users/me ────────────────────────────────────────────────────────────
router.get("/users/me", async (event) => {
  const sub = getSub(event);
  const user = await getUser(sub);
  if (!user) return err("User not found", 404);
  return ok({ user });
});

// ── PATCH /users/me ──────────────────────────────────────────────────────────
router.patch("/users/me", async (event) => {
  const sub = getSub(event);
  return updateUser(sub, event.body);
});

// ── DELETE /users/me ─────────────────────────────────────────────────────────
router.delete("/users/me", async (event) => {
  const sub = getSub(event);
  return deleteUser(sub, event);
});

// ── GET /users/me/inscriptions ───────────────────────────────────────────────
router.get("/users/me/inscriptions", async (event) => {
  const sub = getSub(event);
  return getUserInscriptions(sub);
});

// ── GET /users/me/dictations ─────────────────────────────────────────────────
router.get("/users/me/dictations", async (event) => {
  const sub = getSub(event);
  return getUserDictations(sub);
});

// ── GET /users/{id} ──────────────────────────────────────────────────────────
router.get("/users/{id}", async (event) => {
  if (!(await isAdmin(event))) return err("Forbidden", 403);
  const { id } = event.pathParameters;
  const user = await getUser(id);
  if (!user) return err("User not found", 404);
  return ok({ user });
});

// ── PATCH /users/{id} ────────────────────────────────────────────────────────
router.patch("/users/{id}", async (event) => {
  if (!(await isAdmin(event))) return err("Forbidden", 403);
  const { id } = event.pathParameters;
  return updateUser(id, event.body);
});

// ── DELETE /users/{id} ───────────────────────────────────────────────────────
router.delete("/users/{id}", async (event) => {
  if (!(await isAdmin(event))) return err("Forbidden", 403);
  const { id } = event.pathParameters;
  return deleteUser(id, event);
});

// ── PATCH /users/{id}/role ───────────────────────────────────────────────────
router.patch("/users/{id}/role", async (event) => {
  if (!(await isAdmin(event))) return err("Forbidden", 403);

  const { id } = event.pathParameters;
  const body =
    typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  const { role } = body ?? {};

  if (!["admin", "student"].includes(role)) {
    return err("role must be 'admin' or 'student'");
  }

  const user = await getUser(id);
  if (!user) return err("User not found", 404);

  // Update DynamoDB
  await dynamo.send(
    new UpdateItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ id }),
      UpdateExpression: "SET #role = :role",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: marshall({ ":role": role }),
    }),
  );

  // Update Cognito custom attribute
  await cognito.send(
    new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: id,
      UserAttributes: [{ Name: "custom:role", Value: role }],
    }),
  );

  return ok({ message: "Role updated" });
});

// ── GET /users/{id}/inscriptions ─────────────────────────────────────────────
router.get("/users/{id}/inscriptions", async (event) => {
  if (!(await isAdmin(event))) return err("Forbidden", 403);
  const { id } = event.pathParameters;
  return getUserInscriptions(id);
});

// ── GET /users/{id}/dictations ───────────────────────────────────────────────
router.get("/users/{id}/dictations", async (event) => {
  if (!(await isAdmin(event))) return err("Forbidden", 403);
  const { id } = event.pathParameters;
  return getUserDictations(id);
});

// ─── Shared logic ────────────────────────────────────────────────────────────

async function updateUser(id, rawBody) {
  const user = await getUser(id);
  if (!user) return err("User not found", 404);

  const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  const allowed = ["firstName", "lastName", "number", "profilePictureUrl"];
  const updates = Object.fromEntries(
    Object.entries(body ?? {}).filter(([k]) => allowed.includes(k)),
  );

  if (!Object.keys(updates).length) {
    return err("No valid fields to update");
  }

  const setExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};

  for (const [key, value] of Object.entries(updates)) {
    setExpressions.push(`#${key} = :${key}`);
    expressionAttributeNames[`#${key}`] = key;
    expressionAttributeValues[`:${key}`] = value;
  }

  await dynamo.send(
    new UpdateItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ id }),
      UpdateExpression: `SET ${setExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: marshall(expressionAttributeValues),
    }),
  );

  return ok({ message: "User updated" });
}

async function deleteUser(id, event) {
  const user = await getUser(id);
  if (!user) return err("User not found", 404);

  // Delete from DynamoDB
  await dynamo.send(
    new DeleteItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ id }),
    }),
  );

  // Delete from Cognito
  await cognito.send(
    new AdminDeleteUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: id,
    }),
  );

  return ok({ message: "User deleted" });
}

async function getUserInscriptions(userId) {
  // Query inscriptions by user_id (GSI required: user_id-index)
  const inscRes = await dynamo.send(
    new QueryCommand({
      TableName: "efi-campus-inscriptions",
      IndexName: "user_id-index",
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: marshall({ ":uid": userId }),
    }),
  );

  const inscriptions = (inscRes.Items ?? []).map(unmarshall);
  if (!inscriptions.length) return ok({ inscriptions: [] });

  // Fetch each group + its course in parallel
  const enriched = await Promise.all(
    inscriptions.map(async (insc) => {
      const groupRes = await dynamo.send(
        new GetItemCommand({
          TableName: "efi-campus-groups",
          Key: marshall({ id: insc.group_id }),
        }),
      );
      const group = groupRes.Item ? unmarshall(groupRes.Item) : null;

      let course = null;
      if (group?.course_id) {
        const courseRes = await dynamo.send(
          new GetItemCommand({
            TableName: "efi-campus-courses",
            Key: marshall({ id: group.course_id }),
          }),
        );
        course = courseRes.Item ? unmarshall(courseRes.Item) : null;
      }

      return { ...insc, group, course };
    }),
  );

  return ok({ inscriptions: enriched });
}

async function getUserDictations(userId) {
  // Query dictations by user_id (GSI required: user_id-index)
  const dictRes = await dynamo.send(
    new QueryCommand({
      TableName: "efi-campus-dictations",
      IndexName: "user_id-index",
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: marshall({ ":uid": userId }),
    }),
  );

  const dictations = (dictRes.Items ?? []).map(unmarshall);
  if (!dictations.length) return ok({ dictations: [] });

  const enriched = await Promise.all(
    dictations.map(async (dict) => {
      const groupRes = await dynamo.send(
        new GetItemCommand({
          TableName: "efi-campus-groups",
          Key: marshall({ id: dict.group_id }),
        }),
      );
      const group = groupRes.Item ? unmarshall(groupRes.Item) : null;

      let course = null;
      if (group?.course_id) {
        const courseRes = await dynamo.send(
          new GetItemCommand({
            TableName: "efi-campus-courses",
            Key: marshall({ id: group.course_id }),
          }),
        );
        course = courseRes.Item ? unmarshall(courseRes.Item) : null;
      }

      return { ...dict, group, course };
    }),
  );

  return ok({ dictations: enriched });
}

export const handler = router.handler();
