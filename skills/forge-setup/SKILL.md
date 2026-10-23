---
name: forge-setup
description: Prepare the project in the working directory for long-running work. Creates docs/ with a README if missing, summarizes the agent files, checks the declared toolchain and that credential files exist, then reports a short status. Use when a session starts in a project directory, or when asked to set up or check a project.
model: claude-haiku-5-5
---

# Forge setup

Prepare the project in the working directory. Run the steps in order. Running this twice changes nothing the second time.

## Rules

- Write only `docs/README.md`, and only when it is missing. Never overwrite a file.
- Do not install anything. Do not commit. Do not change other repositories. Do not write memory entries.
- Do not write to a shared or workspace-level docs directory.
- Never read or print a credential file. Check that it exists, nothing more.
- Ask before any step not listed here.

## Steps

1. **Project root.** Confirm the working directory is a project root: it holds a build file (`build.sbt`, `pom.xml`, `go.mod`, `package.json`, or similar) or agent files. Run `git rev-parse --show-toplevel` and note whether the directory is a git repository and whether it is the repository's root. Do not assume a parent directory is a repository.

2. **docs/.** If `docs/` is missing, create it. If `docs/README.md` is missing, write it with this content:

   ```markdown
   # Docs

   This folder holds this project's knowledge: notes, decisions, designs and learnings.

   Name files in lowercase, hyphenated Markdown, for example `release-process.md`.
   ```

   If either exists, leave it as it is and say so.

3. **Agent files.** Read `AGENTS.md` and `CLAUDE.md` at the root and any nested ones (`find . -name AGENTS.md -o -name CLAUDE.md`, skipping `node_modules`, `target` and `.git`). Summarize the build, test and lint commands and the rules that apply. Put the summary in the report only, not in `docs/`.

4. **Toolchain.** From the build files and agent files, list the tools the project declares, such as sbt and JDK 17, Maven, Go or Node. For each, check whether it is installed and which version, with commands such as `command -v sbt`, `java -version`, `mvn -v`, `go version`, `node --version`. Report installed and missing tools. Ask before installing anything.

5. **Credentials.** Where the agent files or build files name a credential file, check only that it exists, for example `test -f ~/.sbt/1.0/akka-commercial.sbt`. Never open, read, print or search it. Report each as present or missing.

6. **Report.** Give a short status:
   - docs: created, or already present
   - commands and rules: the summary from step 3
   - toolchain: installed, missing, version mismatches
   - credentials: present or missing, by file name
   - needs your decision: anything missing or unclear
