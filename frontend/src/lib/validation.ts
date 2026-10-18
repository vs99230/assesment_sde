import type { CreateItemInput, UpdateItemInput } from '../types';
import { ITEM_TYPES, PRIORITIES } from './labels';

export type FieldErrors = Record<string, string>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validTitle(raw: string, errors: FieldErrors): void {
  const title = raw.trim();
  if (title.length < 3) errors.title = 'Title must be at least 3 characters.';
  else if (title.length > 120) errors.title = 'Title must be at most 120 characters.';
}

function validDescription(raw: string, errors: FieldErrors): void {
  if (raw.trim().length > 4000) errors.description = 'Description must be at most 4000 characters.';
}

function validDueDate(raw: string | null | undefined, errors: FieldErrors): void {
  if (raw === null || raw === undefined || raw === '') return;
  if (!DATE_RE.test(raw) || Number.isNaN(Date.parse(raw))) errors.dueDate = 'Enter a valid date.';
}

export function validateCreateInput(input: Partial<CreateItemInput>): FieldErrors {
  const errors: FieldErrors = {};
  validTitle(input.title ?? '', errors);
  validDescription(input.description ?? '', errors);
  if (!input.type || !ITEM_TYPES.includes(input.type)) errors.type = 'Choose a type.';
  if (!input.priority || !PRIORITIES.includes(input.priority)) errors.priority = 'Choose a priority.';
  if (!input.teamId) errors.teamId = 'Choose a team.';
  validDueDate(input.dueDate, errors);
  return errors;
}

export function validateUpdateInput(input: Partial<UpdateItemInput>): FieldErrors {
  const errors: FieldErrors = {};
  if (input.title !== undefined) validTitle(input.title, errors);
  if (input.description !== undefined) validDescription(input.description, errors);
  if (input.priority !== undefined && !PRIORITIES.includes(input.priority)) {
    errors.priority = 'Choose a priority.';
  }
  validDueDate(input.dueDate, errors);
  return errors;
}

export function validateComment(body: string): string | null {
  const text = body.trim();
  if (text.length === 0) return 'Write something before posting.';
  if (text.length > 2000) return 'Comments must be at most 2000 characters.';
  return null;
}

export function validateLogin(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Enter a valid email address.';
  if (password.length === 0) errors.password = 'Enter your password.';
  return errors;
}
