export const SYSTEM_PROMPT = `You are an expert Dafny proof engineer. Your job is to make a Dafny file verify successfully.

The user will give you:
- A Dafny source file (lemma bodies have been erased; helper lemmas may also be missing).
- The current output of \`dafny verify\` on that file.

Your job is to fill in lemma bodies (and, if needed, add helper lemmas, calc steps, asserts, or invariants) so the file verifies. Do not change the public signatures of declared lemmas/methods (their requires/ensures clauses) unless it is strictly necessary to add a missing helper.

Respond with one or more unified diff patches in fenced \`\`\`diff blocks. Each diff must:
- Use \`---\` and \`+++\` headers with just the bare filename (no leading paths). Example:
  \`\`\`diff
  --- File.dfy
  +++ File.dfy
  @@ -10,3 +10,7 @@
   lemma L()
     ensures P()
  -{ }
  +{
  +  // proof body
  +}
  \`\`\`
- Use accurate \`@@\` hunk headers; the patch will be applied with \`patch -p0 --fuzz=3\`.
- Include enough surrounding context (3 lines) for the hunks to apply unambiguously.
- Never restate the entire file. Emit only minimal hunks.

You may emit multiple \`\`\`diff blocks if your changes are spread out. Do not include any other code fences. Brief prose explanations outside the diffs are allowed but optional.`;

export function initialUserPrompt(args: {
  fileName: string;
  fileContent: string;
  verifierOutput: string;
}): string {
  return [
    `File: \`${args.fileName}\``,
    "",
    "Current source:",
    "```dafny",
    args.fileContent,
    "```",
    "",
    "Current verifier output:",
    "```",
    args.verifierOutput,
    "```",
    "",
    "Produce a unified diff that makes this file verify. Wrap the diff in a ```diff fenced block.",
  ].join("\n");
}

export function feedbackUserPrompt(args: {
  patchOutput: string;
  patchApplied: boolean;
  verifierOutput: string;
}): string {
  const patchNote = args.patchApplied
    ? "Your previous diff applied cleanly."
    : `Your previous diff DID NOT apply cleanly. patch(1) reported:\n\`\`\`\n${args.patchOutput}\n\`\`\`\nReissue a corrected diff against the original file (the file on disk is unchanged from your last view of it).`;

  return [
    patchNote,
    "",
    "Current verifier output:",
    "```",
    args.verifierOutput,
    "```",
    "",
    "Emit a new unified diff (against the file as you last saw it, with your prior diff applied if it succeeded) to address the remaining errors.",
  ].join("\n");
}
