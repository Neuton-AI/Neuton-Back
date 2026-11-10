import { z } from 'zod';
import { htmlFree } from '../../lib/safeText.js';

export const signupEmail = z.string().trim().toLowerCase().max(254).email();
export const signupName = htmlFree(z.string().trim().min(1).max(120));
