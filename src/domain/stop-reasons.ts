/**
 * Plain-language wording for the stable codes a stopped run carries. The operator work listing and the
 * browser console both use it, so the two never describe the same code differently. The module has no
 * dependencies because the console bundles it.
 */

export const NO_DESCRIPTION = 'No description is recorded for this code.';

const STOP_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  active_time_exhausted: 'The run used its active-time allowance.',
  steps_exhausted: 'The run used its step allowance.',
  tool_calls_exhausted: 'The run used its tool-call allowance.',
  model_calls_exhausted: 'The run used its model-call allowance.',
  tokens_exhausted: 'The run used its token allowance.',
  cost_exhausted: 'The run used its cost allowance.',
  retries_per_call_exhausted: 'A call kept failing and used its retry allowance.',
  retries_exhausted: 'The run used its retry allowance.',
  tool_error: 'A tool failed in a way retrying cannot fix.',
  account_unavailable: 'The case account could not be read, so no proposal could be made.',
  policy_unavailable: 'No credit policy could be read, so no proposal could be made.',
  no_proposal_submitted: 'The investigation ended without submitting a proposal.',
  live_not_approved: 'Live-model runs are not approved on this deployment.',
  live_not_configured: 'No live-model adapter is configured on this deployment.',
  tenant_cost_exhausted: 'The tenant used its live-model cost allowance for the UTC day.',
  model_auth_failed: 'No access token could be obtained for the model endpoint.',
  model_unauthorized: 'The model endpoint refused the credentials of this application.',
  model_bad_request: 'The model endpoint rejected the request as invalid.',
  model_rate_limited: 'The model endpoint kept throttling the run.',
  model_unavailable: 'The model endpoint was unavailable.',
  model_timeout: 'The model endpoint did not answer in time.',
  model_connection_failed: 'The model endpoint could not be reached.',
  model_response_invalid: 'The model endpoint returned a response this application could not accept.',
  model_client_error: 'The model client failed unexpectedly.',
  model_invalid_tool_calls: 'The model kept requesting tool calls that the application refused.',
  model_turn_limit: 'The model used every turn it was given without submitting a proposal.',
  model_refused: 'The model declined to continue.',
  model_content_filtered: 'The model response was withheld by a content filter.',
  model_output_truncated: 'The model response was cut off before it finished.',
  model_after_submission: 'A model call was attempted after the proposal was submitted.',
});

export const describeStop = (code: string): string => (Object.hasOwn(STOP_MESSAGES, code) ? (STOP_MESSAGES[code] ?? NO_DESCRIPTION) : NO_DESCRIPTION);
