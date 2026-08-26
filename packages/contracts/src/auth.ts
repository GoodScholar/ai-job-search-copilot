import { z } from "zod";

export const StartDevSessionRequestSchema = z.object({
  subject: z.string().min(1).max(80),
}).strict();

export type StartDevSessionRequest = z.infer<typeof StartDevSessionRequestSchema>;

export const AccountSchema = z.object({
  userId: z.string().uuid(),
}).strict();

export const StartDevSessionResponseSchema = z.object({
  account: AccountSchema,
  sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
}).strict();

export const AccountPathSchema = z.object({
  userId: z.string().uuid(),
}).strict();

export const AccountProjectionSchema = z.object({
  account: AccountSchema,
}).strict();
