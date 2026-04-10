import { Router, error, json } from "itty-router";
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { randomUUID } from "crypto";
import { getSub, isAdmin, createHandler } from "router-utils";

const dynamo = new DynamoDBClient({});

const GROUPS_TABLE = process.env.GROUPS_TABLE ?? "efi-campus-groups";
const INSCRIPTIONS_TABLE =
  process.env.INSCRIPTIONS_TABLE ?? "efi-campus-inscriptions";
const DICTATIONS_TABLE =
  process.env.DICTATIONS_TABLE ?? "efi-campus-dictations";
const COURSES_TABLE = process.env.COURSES_TABLE ?? "efi-campus-courses";
const USERS_TABLE = process.env.USERS_TABLE ?? "efi-campus-users";
const CONFIG_TABLE = "efi-campus-config";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getGroup = async (id) => {
  const res = await dynamo.send(
    new GetItemCommand({ TableName: GROUPS_TABLE, Key: marshall({ id }) }),
  );
  return res.Item ? unmarshall(res.Item) : null;
};

const getCurrentTerm = async () => {
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: CONFIG_TABLE,
      Key: marshall({ key: "current_term" }),
    }),
  );
  return res.Item ? unmarshall(res.Item).value : null;
};

const getInscriptionByUser = async (groupId, userId) => {
  const res = await dynamo.send(
    new QueryCommand({
      TableName: INSCRIPTIONS_TABLE,
      IndexName: "group_id-index",
      KeyConditionExpression: "group_id = :gid",
      FilterExpression: "user_id = :uid",
      ExpressionAttributeValues: marshall({ ":gid": groupId, ":uid": userId }),
    }),
  );
  const items = (res.Items ?? []).map(unmarshall);
  return items[0] ?? null;
};

const getUserById = async (id) => {
  const res = await dynamo.send(
    new GetItemCommand({ TableName: USERS_TABLE, Key: marshall({ id }) }),
  );
  return res.Item ? unmarshall(res.Item) : null;
};

const getDictationByUser = async (groupId, userId) => {
  const res = await dynamo.send(
    new QueryCommand({
      TableName: DICTATIONS_TABLE,
      IndexName: "group_id-index",
      KeyConditionExpression: "group_id = :gid",
      FilterExpression: "user_id = :uid",
      ExpressionAttributeValues: marshall({ ":gid": groupId, ":uid": userId }),
    }),
  );
  const items = (res.Items ?? []).map(unmarshall);
  return items[0] ?? null;
};

const getInscriptionsByUserAndTerm = async (userId, term) => {
  const res = await dynamo.send(
    new QueryCommand({
      TableName: INSCRIPTIONS_TABLE,
      IndexName: "user_id-index",
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: marshall({ ":uid": userId }),
    }),
  );
  const inscriptions = (res.Items ?? []).map(unmarshall);

  // Filter and enrich
  const enrichedInscriptions = await Promise.all(
    inscriptions.map(async (insc) => {
      const group = await getGroup(insc.group_id);
      return { ...insc, group };
    }),
  );

  return enrichedInscriptions.filter(
    (insc) => insc.group && insc.group.term === term,
  );
};

const getDictationsByUserAndTerm = async (userId, term) => {
  const res = await dynamo.send(
    new QueryCommand({
      TableName: DICTATIONS_TABLE,
      IndexName: "user_id-index",
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: marshall({ ":uid": userId }),
    }),
  );
  const dictations = (res.Items ?? []).map(unmarshall);

  // Filter and enrich
  const enrichedDictations = await Promise.all(
    dictations.map(async (dict) => {
      const group = await getGroup(dict.group_id);
      return { ...dict, group };
    }),
  );

  return enrichedDictations.filter(
    (dict) => dict.group && dict.group.term === term,
  );
};

const getProfessorsByGroupId = async (groupId) => {
  const res = await dynamo.send(
    new QueryCommand({
      TableName: DICTATIONS_TABLE,
      IndexName: "group_id-index",
      KeyConditionExpression: "group_id = :gid",
      ExpressionAttributeValues: marshall({ ":gid": groupId }),
    }),
  );
  const dictations = (res.Items ?? []).map(unmarshall);

  const professors = await Promise.all(
    dictations.map(async (dict) => {
      const user = await getUserById(dict.user_id);
      return user
        ? {
            id: user.id,
            firstName: user.first_name,
            lastName: user.last_name,
            phoneNumber: user.phone_number,
            dictationId: dict.id,
          }
        : null;
    }),
  );
  return professors.filter((p) => p !== null);
};

// ─── Router ───────────────────────────────────────────────────────────────────

const router = Router();

// GET /groups — admin, todos los grupos
router.get("/groups", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const res = await dynamo.send(new ScanCommand({ TableName: GROUPS_TABLE }));
  const groups = (res.Items ?? []).map(unmarshall);

  const enriched = await Promise.all(
    groups.map(async (group) => {
      const professors = await getProfessorsByGroupId(group.id);
      return { ...group, professors };
    }),
  );

  return json({ groups: enriched });
});

// GET /groups/available — grupos del term actual con open = true, join con curso
router.get("/groups/available", async (request) => {
  const currentTerm = await getCurrentTerm();
  if (!currentTerm) return error(500, "Current term not configured");

  const res = await dynamo.send(
    new QueryCommand({
      TableName: GROUPS_TABLE,
      IndexName: "term-index",
      KeyConditionExpression: "#term = :term",
      FilterExpression: "#open = :open",
      ExpressionAttributeNames: { "#term": "term", "#open": "open" },
      ExpressionAttributeValues: marshall({
        ":term": currentTerm,
        ":open": true,
      }),
    }),
  );

  let groups = (res.Items ?? []).map(unmarshall);

  try {
    const sub = getSub(request);
    const userInscriptions = await getInscriptionsByUserAndTerm(sub, currentTerm);
    const userDictations = await getDictationsByUserAndTerm(sub, currentTerm);
    
    const enrolledCourseIds = userInscriptions.map((insc) => insc.group.course_id);
    const dictatingCourseIds = userDictations.map((dict) => dict.group.course_id);
    const forbiddenCourseIds = [...enrolledCourseIds, ...dictatingCourseIds];

    groups = groups.filter((g) => !forbiddenCourseIds.includes(g.course_id));
  } catch (e) {
    // If not authenticated or error, show all available
  }

  const enriched = await Promise.all(
    groups.map(async (group) => {
      let course = null;
      if (group.course_id) {
        const courseRes = await dynamo.send(
          new GetItemCommand({
            TableName: COURSES_TABLE,
            Key: marshall({ id: group.course_id }),
          }),
        );
        course = courseRes.Item ? unmarshall(courseRes.Item) : null;
      }
      return { ...group, course };
    }),
  );

  return json({ groups: enriched });
});

// GET /groups/:id — admin siempre; usuario solo si está inscrito
// Incluye dictante solo si open = false
router.get("/groups/:id", async (request) => {
  const admin = await isAdmin(request);
  const group = await getGroup(request.params.id);
  if (!group) return error(404, "Group not found");

  if (!admin) {
    const sub = getSub(request);
    const inscription = await getInscriptionByUser(request.params.id, sub);
    if (!inscription) return error(403, "Forbidden");
  }

  let result = { ...group };

  // Join curso
  if (group.course_id) {
    const courseRes = await dynamo.send(
      new GetItemCommand({
        TableName: COURSES_TABLE,
        Key: marshall({ id: group.course_id }),
      }),
    );
    result.course = courseRes.Item ? unmarshall(courseRes.Item) : null;
  }

  // Join dictantes
  result.professors = await getProfessorsByGroupId(group.id);

  return json({ group: result });
});

// POST /groups — admin
router.post("/groups", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const currentTerm = await getCurrentTerm();
  if (!currentTerm) return error(500, "Current term not configured");

  const body = await request.json().catch(() => ({}));
  const { course_id, structure_id, schedule, day_of_week } = body;

  if (!course_id) return error(400, "course_id is required");

  const courseRes = await dynamo.send(
    new GetItemCommand({
      TableName: COURSES_TABLE,
      Key: marshall({ id: course_id }),
    }),
  );
  if (!courseRes.Item) return error(404, "Course not found");

  const group = {
    id: randomUUID(),
    course_id,
    structure_id: structure_id ?? null,
    term: currentTerm,
    schedule: schedule ?? null,
    day_of_week: day_of_week ?? null,
    open: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await dynamo.send(
    new PutItemCommand({ TableName: GROUPS_TABLE, Item: marshall(group) }),
  );

  return json({ group }, { status: 201 });
});

// PATCH /groups/:id — admin
router.patch("/groups/:id", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const group = await getGroup(request.params.id);
  if (!group) return error(404, "Group not found");

  const body = await request.json().catch(() => ({}));
  const allowed = ["structure_id", "schedule", "day_of_week", "term"];
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
      TableName: GROUPS_TABLE,
      Key: marshall({ id: request.params.id }),
      UpdateExpression: `SET ${setExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: marshall(expressionAttributeValues),
    }),
  );

  return json({ message: "Group updated" });
});

// PATCH /groups/:id/open — admin, togglea open
router.patch("/groups/:id/open", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const group = await getGroup(request.params.id);
  if (!group) return error(404, "Group not found");

  const newOpen = !group.open;

  await dynamo.send(
    new UpdateItemCommand({
      TableName: GROUPS_TABLE,
      Key: marshall({ id: request.params.id }),
      UpdateExpression: "SET #open = :open, updated_at = :updated_at",
      ExpressionAttributeNames: { "#open": "open" },
      ExpressionAttributeValues: marshall({
        ":open": newOpen,
        ":updated_at": new Date().toISOString(),
      }),
    }),
  );

  return json({ open: newOpen });
});

// DELETE /groups/:id — admin
router.delete("/groups/:id", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const group = await getGroup(request.params.id);
  if (!group) return error(404, "Group not found");

  await dynamo.send(
    new DeleteItemCommand({
      TableName: GROUPS_TABLE,
      Key: marshall({ id: request.params.id }),
    }),
  );

  return json({ message: "Group deleted" });
});

// GET /groups/:id/inscriptions — usuario inscrito solo si open = false; admin siempre
router.get("/groups/:id/inscriptions", async (request) => {
  const admin = await isAdmin(request);
  const group = await getGroup(request.params.id);
  if (!group) return error(404, "Group not found");

  if (!admin) {
    if (group.open)
      return error(403, "Inscriptions are not visible while group is open");
    const sub = getSub(request);
    const inscription = await getInscriptionByUser(request.params.id, sub);
    if (!inscription) return error(403, "Forbidden");
  }

  const res = await dynamo.send(
    new QueryCommand({
      TableName: INSCRIPTIONS_TABLE,
      IndexName: "group_id-index",
      KeyConditionExpression: "group_id = :gid",
      ExpressionAttributeValues: marshall({ ":gid": request.params.id }),
    }),
  );

  const inscriptions = (res.Items ?? []).map(unmarshall);

  const enriched = await Promise.all(
    inscriptions.map(async (insc) => {
      const user = await getUserById(insc.user_id);
      return {
        ...insc,
        user: user
          ? {
              id: user.id,
              firstName: user.first_name,
               lastName: user.last_name,
               phoneNumber: user.phone_number,
               profilePictureUrl: user.profile_picture_url,
            }
          : null,
      };
    }),
  );

  return json({ inscriptions: enriched });
});

// POST /groups/:id/inscriptions — usuario si open y term actual; admin siempre
router.post("/groups/:id/inscriptions", async (request) => {
  const admin = await isAdmin(request);
  const group = await getGroup(request.params.id);
  if (!group) return error(404, "Group not found");

  const sub = getSub(request);

  const body = await request.json().catch(() => ({}));
  const userId = admin ? (body.user_id ?? sub) : sub;

  const currentTerm = await getCurrentTerm();
  const userInscriptions = await getInscriptionsByUserAndTerm(userId, currentTerm);

  // Check if user is already in a group for this course in this term
  const alreadyEnrolledInCourse = userInscriptions.some(
    (insc) => insc.group.course_id === group.course_id,
  );
  if (alreadyEnrolledInCourse)
    return error(409, "Already inscribed in a group for this course in the current term");

  if (!admin) {
    if (!group.open) return error(403, "Group is closed for inscriptions");

    if (group.term !== currentTerm)
      return error(403, "Group is not in the current term");

    const existing = await getInscriptionByUser(request.params.id, userId);
    if (existing) return error(409, "Already inscribed in this group");

    const existingDictation = await getDictationByUser(
      request.params.id,
      userId,
    );
    if (existingDictation)
      return error(409, "User is already a professor in this group");
  } else {
    const existing = await getInscriptionByUser(request.params.id, userId);
    if (existing) return error(409, "User is already inscribed in this group");

    const existingDictation = await getDictationByUser(
      request.params.id,
      userId,
    );
    if (existingDictation)
      return error(409, "User is already a professor in this group");
  }

  const inscription = {
    id: randomUUID(),
    group_id: request.params.id,
    user_id: userId,
    created_at: new Date().toISOString(),
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: INSCRIPTIONS_TABLE,
      Item: marshall(inscription),
    }),
  );

  return json({ inscription }, { status: 201 });
});

// DELETE /groups/:id/inscriptions/me — usuario borra la suya si open = true
router.delete("/groups/:id/inscriptions/me", async (request) => {
  const group = await getGroup(request.params.id);
  if (!group) return error(404, "Group not found");
  if (!group.open) return error(403, "Cannot leave a closed group");

  const sub = getSub(request);
  const inscription = await getInscriptionByUser(request.params.id, sub);
  if (!inscription) return error(404, "Inscription not found");

  await dynamo.send(
    new DeleteItemCommand({
      TableName: INSCRIPTIONS_TABLE,
      Key: marshall({ id: inscription.id }),
    }),
  );

  return json({ message: "Inscription deleted" });
});

// DELETE /groups/:id/inscriptions/:inscriptionId — admin
router.delete("/groups/:id/inscriptions/:inscriptionId", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const res = await dynamo.send(
    new GetItemCommand({
      TableName: INSCRIPTIONS_TABLE,
      Key: marshall({ id: request.params.inscriptionId }),
    }),
  );
  if (!res.Item) return error(404, "Inscription not found");

  await dynamo.send(
    new DeleteItemCommand({
      TableName: INSCRIPTIONS_TABLE,
      Key: marshall({ id: request.params.inscriptionId }),
    }),
  );

  return json({ message: "Inscription deleted" });
});

// GET /groups/:id/dictations — admin
router.get("/groups/:id/dictations", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const group = await getGroup(request.params.id);
  if (!group) return error(404, "Group not found");

  const res = await dynamo.send(
    new QueryCommand({
      TableName: DICTATIONS_TABLE,
      IndexName: "group_id-index",
      KeyConditionExpression: "group_id = :gid",
      ExpressionAttributeValues: marshall({ ":gid": request.params.id }),
    }),
  );

  const dictations = (res.Items ?? []).map(unmarshall);

  const enriched = await Promise.all(
    dictations.map(async (dict) => {
      const user = await getUserById(dict.user_id);
      return {
        ...dict,
        user: user
          ? {
              id: user.id,
              firstName: user.first_name,
              lastName: user.last_name,
              phoneNumber: user.phone_number,
              profilePictureUrl: user.profile_picture_url,
            }
          : null,
      };
    }),
  );

  return json({ dictations: enriched });
});

// POST /groups/:id/dictations — admin
router.post("/groups/:id/dictations", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const group = await getGroup(request.params.id);
  if (!group) return error(404, "Group not found");

  const { user_id } = await request.json().catch(() => ({}));
  if (!user_id) return error(400, "user_id is required");

  const professor = await getUserById(user_id);
  if (!professor) return error(404, "User not found");

  const existingDictation = await getDictationByUser(
    request.params.id,
    user_id,
  );
  if (existingDictation)
    return error(409, "User is already a professor in this group");

  // Si tiene una inscripción en este grupo, borrarla
  const existingInscription = await getInscriptionByUser(
    request.params.id,
    user_id,
  );
  if (existingInscription) {
    await dynamo.send(
      new DeleteItemCommand({
        TableName: INSCRIPTIONS_TABLE,
        Key: marshall({ id: existingInscription.id }),
      }),
    );
  }

  const dictation = {
    id: randomUUID(),
    group_id: request.params.id,
    user_id,
    created_at: new Date().toISOString(),
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: DICTATIONS_TABLE,
      Item: marshall(dictation),
    }),
  );

  return json({ dictation }, { status: 201 });
});

// DELETE /groups/:id/dictations/:dictationId — admin
router.delete("/groups/:id/dictations/:dictationId", async (request) => {
  if (!(await isAdmin(request))) return error(403, "Forbidden");

  const res = await dynamo.send(
    new GetItemCommand({
      TableName: DICTATIONS_TABLE,
      Key: marshall({ id: request.params.dictationId }),
    }),
  );
  if (!res.Item) return error(404, "Dictation not found");

  await dynamo.send(
    new DeleteItemCommand({
      TableName: DICTATIONS_TABLE,
      Key: marshall({ id: request.params.dictationId }),
    }),
  );

  return json({ message: "Dictation deleted" });
});

export const handler = createHandler(router);
