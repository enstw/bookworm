See AGENT.md for all project context, architecture, commands, and conventions.

All rules and conventions should be added to AGENT.md, not this file. Critical rules are inlined below.

## Critical Rules
- **Version bump on every push**: Before pushing, bump the patch version in `package.json` (`npm version patch --no-git-tag-version`), run `npm run build` (this bakes both the version and git hash into `app.js`), and include `package.json` and `app.js` in the commit.
