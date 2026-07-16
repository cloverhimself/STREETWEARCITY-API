import { Router } from "express";

// TODO(next phase): list endpoint for the admin activity log view. Writing
// to ActivityLog is the job of a shared service called from every other
// module's mutating endpoints, not this router.
export const activityLogsRouter = Router();
