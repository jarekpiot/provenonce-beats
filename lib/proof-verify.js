export const MIN_PROOF_SPOT_CHECKS = 3;

export function validateProofSpotChecks(proof, minChecks = MIN_PROOF_SPOT_CHECKS) {
  if (!Array.isArray(proof?.spot_checks) || proof.spot_checks.length < minChecks) {
    return {
      valid: false,
      reason: `At least ${minChecks} spot checks are required`,
    };
  }

  let hasEndpointCheck = false;
  for (const check of proof.spot_checks) {
    if (check?.index === proof.to_beat) {
      hasEndpointCheck = true;
      break;
    }
  }

  if (!hasEndpointCheck) {
    return {
      valid: false,
      reason: 'spot_checks must include endpoint to_beat',
    };
  }

  return { valid: true, reason: null };
}

