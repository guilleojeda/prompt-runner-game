export type ReadFailureClassification =
  | { readonly kind: 'authentication'; readonly authContext?: number }
  | { readonly kind: 'definitive' | 'pending' | 'transient' };
