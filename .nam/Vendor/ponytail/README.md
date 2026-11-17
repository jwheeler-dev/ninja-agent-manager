# ponytail (vendored)

NAM ships the Cursor rule from [ponytail](https://github.com/DietrichGebert/ponytail) by Dietrich Gebert, under the MIT license in `LICENSE` next to this file.

| | |
|---|---|
| Source | https://github.com/DietrichGebert/ponytail/blob/v5.3.3/.cursor/rules/ponytail.mdc |
| Tag | `v5.3.3` |
| Commit | `7801d061243d7b753bad0e0b3c057cd250b11755` |
| Copy | `.cursor/rules/ponytail.mdc`, unmodified |

The NAM installer copies the rule into each project and gitignores it in its managed block. Claude Code gets ponytail from its plugin instead. See `.nam/Guides/Automation_Guide.md`, ponytail integration.

## Update

1. Fetch the rule and the license at the new tag (from the NAM source repo root):

   ```bash
   TAG=v5.x.y
   gh api "repos/DietrichGebert/ponytail/contents/.cursor/rules/ponytail.mdc?ref=$TAG" --jq .content | base64 -d > .cursor/rules/ponytail.mdc
   gh api "repos/DietrichGebert/ponytail/contents/LICENSE?ref=$TAG" --jq .content | base64 -d > .nam/Vendor/ponytail/LICENSE
   gh api "repos/DietrichGebert/ponytail/commits/$TAG" --jq .sha
   ```

   In Git Bash, `export MSYS_NO_PATHCONV=1` first.
2. Put the new tag and commit in the table above.
3. Read the rule's diff against NAM's contract (`.cursor/commands/nam-impl.md`, Code discipline) and adjust the prompts if they now conflict.
4. Bump `.nam/metadata.json`, commit, and re-run the installer in each project.
