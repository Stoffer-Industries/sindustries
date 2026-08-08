// Read-only endpoint that exposes the configured taskType -> required-approvals
// mapping. The lobster reads this once per `load-task` invocation and caches
// for the run, so consumers don't have to read the YAML file directly.
//
// See docs/specs/tasks-api-native-approvals-tech-design.md WS2.

import { Router } from 'express';
import { badRequest } from '../lib/http.ts';
import {
  loadRequiredApprovalsConfig,
  requiredApprovalsFor
} from '../config/requiredApprovals.ts';
import { validTaskTypes } from './tasks/_constants.ts';

export const requiredApprovalsRouter = Router();

requiredApprovalsRouter.get('/task-types/:taskType/required-approvals', (req, res, next) => {
  try {
    const taskType = String(req.params.taskType ?? '').trim();
    if (!taskType) {
      return badRequest(res, 'INVALID_TASK_TYPE', 'taskType is required');
    }
    if (!validTaskTypes.has(taskType)) {
      return badRequest(
        res,
        'INVALID_TASK_TYPE',
        'taskType must be one of: content, code, research, feature'
      );
    }

    const config = loadRequiredApprovalsConfig();
    const required = requiredApprovalsFor(config, taskType);

    return res.status(200).json({
      data: {
        taskType,
        requiredApprovals: required,
        version: config.version,
        source: config.source
      }
    });
  } catch (error) {
    return next(error);
  }
});
