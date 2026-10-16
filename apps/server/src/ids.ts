// UUIDv7, generated app-side (ARCHITECTURE §1: time-ordered, index-friendly).
import { v7 as uuidv7 } from 'uuid';

export function newId(): string {
  return uuidv7();
}
