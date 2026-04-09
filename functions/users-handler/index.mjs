import { Router, error, json } from "itty-router";
import {
  DynamoDBClient,
  GetItemCommand,
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
import { getSub, isAdmin, createHandler } from "router-utils";

const dynamo = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.USER_POOL_ID;
const USERS_TABLE = process.env.USERS_TABLE ?? "efi-campus-users";
const INSCRIPTIONS_TABLE =
  process.env.INSCRIPTIONS_TABLE ?? "efi-campus-inscriptions";
const DICTATIONS_TABLE =
  process.env.DICTATIONS_TABLE ?? "efi-campus-dictations";
const GROUPS_TABLE = process.env.GROUPS_TABLE ?? "efi-campus-groups";
const COURSES_TABLE = process.env.COURSES_TABLE ?? "efi-campus-courses";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getUser = async (id) => {
  const res = await dynamo.send(
    new GetItemCommand({ TableName: USERS_TABLE, Key: marshall({ id }) }),
  );
  return res.Item ? unmarshall(res.Item) : null;
};

// ─── Shared logic ─────────────────────────────────────────────────────────────

async function updateUser(id, rawBody) {
  const user = await getUser(id);
  if (!user) return error(404, "User not found");

  const body =
    typeof rawBody === "string" ? JSON.parse(rawBody) : (rawBody ?? {});
  const allowed = [
    "first_name",
    "last_name",
    "phone_number",
    "profile_picture_url",
  ];
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k)),
  );

  if (!Object.keys(updates).length)
    return error(400, "No valid fields to update");

  // Validar unicidad de phone_number
  if (updates.phone_number !== undefined) {
    const existing = await dynamo.send(
      new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: "phone_number-index",
        KeyConditionExpression: "phone_number = :phone",
        ExpressionAttributeValues: marshall({ ":phone": updates.phone_number }),
      }),
    );
    const match = (existing.Items ?? [])
      .map(unmarshall)
      .find((u) => u.id !== id);
    if (match) return error(409, "Phone number already in use");
  }

  updates.updated_at = new Date().toISOString();

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

  const cognitoFieldMap = {
    first_name: "given_name",
    last_name: "family_name",
    phone_number: "phone_number",
  };

  const cognitoAttributes = Object.entries(cognitoFieldMap)
    .filter(([k]) => updates[k] !== undefined)
    .map(([k, cognitoName]) => ({
      Name: cognitoName,
      Value: String(updates[k]),
    }));

  if (cognitoAttributes.length) {
    await cognito.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: id,
        UserAttributes: cognitoAttributes,
      }),
    );
  }

  return json({ message: "User updated" });
}

async function deleteUser(id) {
  const user = await getUser(id);
  if (!user) return error(404, "User not found");

  await dynamo.send(
    new DeleteItemCommand({ TableName: USERS_TABLE, Key: marshall({ id }) }),
  );

  await cognito.send(
    new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: id }),
  );

  return json({ message: "User deleted" });
}

async function getUserInscriptions(userId) {
  const inscRes = await dynamo.send(
    new QueryCommand({
      TableName: INSCRIPTIONS_TABLE,
      IndexName: "user_id-index",
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: marshall({ ":uid": userId }),
    }),
  );

  const inscriptions = (inscRes.Items ?? []).map(unmarshall);
  if (!inscriptions.length) return json({ inscriptions: [] });

  const enriched = await Promise.all(
    inscriptions.map(async (insc) => {
      const groupRes = await dynamo.send(
        new GetItemCommand({
          TableName: GROUPS_TABLE,
          Key: marshall({ id: insc.group_id }),
        }),
      );
      const group = groupRes.Item ? unmarshall(groupRes.Item) : null;

      let course = null;
      if (group?.course_id) {
        const courseRes = await dynamo.send(
          new GetItemCommand({
            TableName: COURSES_TABLE,
            Key: marshall({ id: group.course_id }),
          }),
        );
        course = courseRes.Item ? unmarshall(courseRes.Item) : null;
      }

      return { ...insc, group, course };
    }),
  );

  return json({ inscriptions: enriched });
}

async function getUserDictations(userId) {
  const dictRes = await dynamo.send(
    new QueryCommand({
      TableName: DICTATIONS_TABLE,
      IndexName: "user_id-index",
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: marshall({ ":uid": userId }),
    }),
  );

  const dictations = (dictRes.Items ?? []).map(unmarshall);
  if (!dictations.length) return json({ dictations: [] });

  const enriched = await Promise.all(
    dictations.map(async (dict) => {
      const groupRes = await dynamo.send(
        new GetItemCommand({
          TableName: GROUPS_TABLE,
          Key: marshall({ id: dict.group_id }),
        }),
      );
      const group = groupRes.Item ? unmarshall(groupRes.Item) : null;

      let course = null;
      if (group?.course_id) {
        const courseRes = await dynamo.send(
          new GetItemCommand({
            TableName: COURSES_TABLE,
            Key: marshall({ id: group.course_id }),
          }),
        );
        course = courseRes.Item ? unmarshall(courseRes.Item) : null;
      }

      return { ...dict, group, course };
    }),
  );

  return json({ dictations: enriched });
}

// ─── Router ───────────────────────────────────────────────────────────────────

const router = Router();

router.get("/users", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const { role, search } = request.query ?? {};
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
    filterExpressions.push(
      "(contains(#fn, :search) OR contains(#ln, :search) OR contains(#email, :search))",
    );
    expressionAttributeNames["#fn"] = "first_name";
    expressionAttributeNames["#ln"] = "last_name";
    expressionAttributeNames["#email"] = "email";
    expressionAttributeValues[":search"] = { S: search.toLowerCase() };
  }

  if (filterExpressions.length) {
    params.FilterExpression = filterExpressions.join(" AND ");
    params.ExpressionAttributeNames = expressionAttributeNames;
    params.ExpressionAttributeValues = expressionAttributeValues;
  }

  const res = await dynamo.send(new ScanCommand(params));
  return json({ users: (res.Items ?? []).map(unmarshall) });
});

router.get("/users/me/inscriptions", async (request) => {
  return getUserInscriptions(getSub(request));
});

router.get("/users/me/dictations", async (request) => {
  return getUserDictations(getSub(request));
});

router.get("/users/me", async (request) => {
  const user = await getUser(getSub(request));
  if (!user) return error(404, "User not found");
  return json({ user });
});

router.patch("/users/me", async (request) => {
  const body = await request.json().catch(() => ({}));
  return updateUser(getSub(request), body);
});

router.delete("/users/me", async (request) => {
  return deleteUser(getSub(request));
});

router.get("/users/:id/inscriptions", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");
  return getUserInscriptions(request.params.id);
});

router.get("/users/:id/dictations", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");
  return getUserDictations(request.params.id);
});

router.patch("/users/:id/role", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const { role } = await request.json().catch(() => ({}));
  if (!["admin", "student"].includes(role)) {
    return error(400, "role must be 'admin' or 'student'");
  }

  const user = await getUser(request.params.id);
  if (!user) return error(404, "User not found");

  await dynamo.send(
    new UpdateItemCommand({
      TableName: USERS_TABLE,
      Key: marshall({ id: request.params.id }),
      UpdateExpression: "SET #role = :role",
      ExpressionAttributeNames: { "#role": "role" },
      ExpressionAttributeValues: marshall({ ":role": role }),
    }),
  );

  return json({ message: "Role updated" });
});

router.get("/users/:id", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");
  const user = await getUser(request.params.id);
  if (!user) return error(404, "User not found");
  return json({ user });
});

router.patch("/users/:id", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");
  const body = await request.json().catch(() => ({}));
  return updateUser(request.params.id, body);
});

router.delete("/users/:id", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");
  return deleteUser(request.params.id);
});

export const handler = createHandler(router);
