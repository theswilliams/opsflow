export interface ActionState {
  error?: string;
  ok?: string;
  fieldErrors?: Record<string, string>;
  /** One-time payload, e.g. a newly created webhook secret. */
  secret?: { keyId: string; secret: string };
}
