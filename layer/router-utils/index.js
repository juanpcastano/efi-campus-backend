import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
 
const dynamo = new DynamoDBClient({});
const USERS_TABLE = process.env.USERS_TABLE ?? "efi-campus-users";
 
// ─── Lambda ↔ itty-router adapter ────────────────────────────────────────────
 
export const fromEvent = (event) => {
  const { rawPath, rawQueryString, requestContext, body, headers } = event;
  const url = `https://lambda${rawPath}${rawQueryString ? `?${rawQueryString}` : ""}`;
  const method = requestContext.http.method;
  const request = new Request(url, {
    method,
    headers: headers ?? {},
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
  });
  request.lambdaEvent = event;
  return request;
};
 
export const toResponse = async (response) => {
  const body = await response.text();
  return {
    statusCode: response.status,
    headers: { "Content-Type": "application/json" },
    body,
  };
};
 
// ─── Auth helpers ─────────────────────────────────────────────────────────────
 
export const getSub = (request) =>
  request.lambdaEvent?.requestContext?.authorizer?.jwt?.claims?.sub;
 
export const getCallerUser = async (request) => {
  const sub = getSub(request);
  if (!sub) return null;
  const res = await dynamo.send(
    new GetItemCommand({ TableName: USERS_TABLE, Key: marshall({ id: sub }) })
  );
  return res.Item ? unmarshall(res.Item) : null;
};
 
export const isAdmin = async (request) => {
  const user = await getCallerUser(request);
  return user?.role === "admin";
};
 
// ─── Lambda handler factory ───────────────────────────────────────────────────
 
export const createHandler = (router) => async (event) => {
  const request = fromEvent(event);
  const response = await router.fetch(request);
  if (!response) return { statusCode: 404, body: JSON.stringify({ message: "Not found" }) };
  return toResponse(response);
};
