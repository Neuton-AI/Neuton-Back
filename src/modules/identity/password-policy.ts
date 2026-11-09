import { z } from 'zod';

export const existingPasswordSchema = z.string().min(1).max(128);
export const newPasswordSchema = z.string().min(10).max(128);
