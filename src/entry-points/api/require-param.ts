import { z } from 'zod'

// Express types route params as possibly undefined (or string[] for
// repeated segments); this narrows and validates in one step so handlers
// never deal with the union.
export function requireParam(params: Record<string, string | string[] | undefined>, name: string): string {
  return z.string().min(1).parse(params[name])
}
