import { Router, error, json } from "itty-router";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { randomUUID } from "crypto";
import { isAdmin, createHandler } from "router-utils";

const dynamo = new DynamoDBClient({});
const COURSES_TABLE = process.env.COURSES_TABLE ?? "efi-campus-courses";

const router = Router();

router.get("/courses", async () => {
  const res = await dynamo.send(new ScanCommand({ TableName: COURSES_TABLE }));
  return json({ courses: (res.Items ?? []).map(unmarshall) });
});

router.get("/courses/:id", async (request) => {
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: COURSES_TABLE,
      Key: marshall({ id: request.params.id }),
    }),
  );
  if (!res.Item) return error(404, "Course not found");
  return json({ course: unmarshall(res.Item) });
});

router.post("/courses", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const { name, description, portrait_url } = await request
    .json()
    .catch(() => ({}));
  if (!name) return error(400, "name is required");

  const course = {
    id: randomUUID(),
    name,
    description: description ?? "",
    portrait_url: portrait_url ?? "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await dynamo.send(
    new PutItemCommand({ TableName: COURSES_TABLE, Item: marshall(course) }),
  );

  return json({ course }, { status: 201 });
});

router.patch("/courses/:id", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const res = await dynamo.send(
    new GetItemCommand({
      TableName: COURSES_TABLE,
      Key: marshall({ id: request.params.id }),
    }),
  );
  if (!res.Item) return error(404, "Course not found");

  const body = await request.json().catch(() => ({}));
  const allowed = ["name", "description", "portrait_url"];
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k)),
  );

  if (!Object.keys(updates).length)
    return error(400, "No valid fields to update");

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
      TableName: COURSES_TABLE,
      Key: marshall({ id: request.params.id }),
      UpdateExpression: `SET ${setExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: marshall(expressionAttributeValues),
    }),
  );

  return json({ message: "Course updated" });
});

router.delete("/courses/:id", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const res = await dynamo.send(
    new GetItemCommand({
      TableName: COURSES_TABLE,
      Key: marshall({ id: request.params.id }),
    }),
  );
  if (!res.Item) return error(404, "Course not found");

  await dynamo.send(
    new DeleteItemCommand({
      TableName: COURSES_TABLE,
      Key: marshall({ id: request.params.id }),
    }),
  );

  return json({ message: "Course deleted" });
});

export const handler = createHandler(router);
