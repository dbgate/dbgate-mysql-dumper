import { createCanonicalIdentity } from '../utils/hash.js';
import type { ArchiveObjectType } from './types.js';

export interface ArchiveIdentityInput {
  readonly objectType: ArchiveObjectType;
  readonly databaseName: string;
  readonly name: string;
  readonly parentName?: string;
}

export function createArchiveIdentity(input: ArchiveIdentityInput): string {
  return createCanonicalIdentity([
    input.objectType,
    input.databaseName,
    input.name,
    input.parentName ?? '',
  ]);
}
