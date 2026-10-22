import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { isTransientDatabaseError, RETRY_AFTER_SECONDS, SERVICE_UNAVAILABLE_CODE, SERVICE_UNAVAILABLE_MESSAGE } from '../lib/dbErrors.js';
import type { HttpRequest } from './request-context.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<Response>();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong';
    let details: unknown;
    if (error instanceof ZodError) {
      status = 400; code = 'VALIDATION_ERROR'; message = 'Invalid request'; details = error.issues;
    } else if (error instanceof AppError) {
      status = error.statusCode; code = error.code; message = error.message; details = error.details;
    } else if (isTransientDatabaseError(error)) {
      status = 503; code = SERVICE_UNAVAILABLE_CODE; message = SERVICE_UNAVAILABLE_MESSAGE;
      response.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
    } else if (error instanceof HttpException && error.getStatus() < 500) {
      status = error.getStatus();
      code = status === 404 ? 'NOT_FOUND' : 'REQUEST_ERROR';
      message = status === 404 ? 'Route not found' : error.message;
    } else if (error instanceof Error && 'status' in error && typeof error.status === 'number') {
      // Express body parser errors contain the submitted body; never echo it.
      if (error.status === 413) { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Request body too large'; }
      if (error.status === 400) { status = 400; code = 'BAD_REQUEST'; message = 'Invalid request body'; }
      if (error.status === 415) { status = 415; code = 'UNSUPPORTED_MEDIA_TYPE'; message = 'Unsupported request encoding'; }
    }
    if (status >= 500) request.log?.error({
      event: 'http_request_failed', statusCode: status, errorCode: code,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      // Messages, SQL parameters and arbitrary error properties can contain PII.
      // Retain call sites, excluding the message and chained-cause text.
      stackFrames: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 20) : undefined,
    }, 'request failed');
    response.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }), traceId: request.traceId } });
  }
}
