import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { lstatSync, readFileSync, realpathSync, statSync } from "fs";
import { globSync } from "glob";
import ignore, { type Ignore } from "ignore";
import { encodingForModel } from "js-tiktoken";
import path from "path";
import { resolveToCwd } from "./path-utils.js";

const bulkLoadSchema = Type.Object({
	glob: Type.String({
		description: "Glob pattern to match files, e.g. 'fs/ext4/**/*.{c,h}' or 'src/**/*.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Base directory to search in (default: current directory)" })),
	maxTokens: Type.Optional(Type.Number({ description: "Maximum token budget (default: 500000)" })),
});

export type BulkLoadToolInput = Static<typeof bulkLoadSchema>;

const DEFAULT_MAX_TOKENS = 500_000;

export interface BulkLoadToolDetails {
	filesLoaded: number;
	filesSkipped: number;
	totalTokens: number;
	skippedFiles: string[];
}

/**
 * Pluggable operations for the bulk-load tool.
 * Override these to delegate file operations to remote systems (e.g., SSH).
 */
export interface BulkLoadOperations {
	/** Check if path exists and is a directory */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents */
	readFile: (absolutePath: string) => Promise<string> | string;
	/** Get file stats (for symlink detection) */
	lstat: (
		absolutePath: string,
	) => Promise<{ isSymbolicLink: boolean; isFile: boolean }> | { isSymbolicLink: boolean; isFile: boolean };
	/** Resolve symlink to real path */
	realpath: (absolutePath: string) => Promise<string> | string;
	/** Find files matching glob pattern */
	glob: (pattern: string, cwd: string, options: { ignore: string[] }) => Promise<string[]> | string[];
	/** Read .gitignore file contents (returns empty string if not found) */
	readGitignore: (absolutePath: string) => Promise<string> | string;
}

const defaultBulkLoadOperations: BulkLoadOperations = {
	isDirectory: (p) => {
		try {
			return statSync(p).isDirectory();
		} catch {
			return false;
		}
	},
	readFile: (p) => readFileSync(p, "utf-8"),
	lstat: (p) => {
		const stats = lstatSync(p);
		return { isSymbolicLink: stats.isSymbolicLink(), isFile: stats.isFile() };
	},
	realpath: (p) => realpathSync(p),
	glob: (pattern, cwd, options) => {
		return globSync(pattern, {
			cwd,
			dot: true,
			nodir: true,
			absolute: true,
			ignore: options.ignore,
		});
	},
	readGitignore: (p) => {
		try {
			return readFileSync(p, "utf-8");
		} catch {
			return "";
		}
	},
};

export interface BulkLoadToolOptions {
	/** Custom operations for bulk-load. Default: local filesystem */
	operations?: BulkLoadOperations;
}

// Lazy-initialized tokenizer
let tokenizer: ReturnType<typeof encodingForModel> | null = null;

function getTokenizer() {
	if (!tokenizer) {
		tokenizer = encodingForModel("gpt-4");
	}
	return tokenizer;
}

function countTokens(text: string): number {
	return getTokenizer().encode(text).length;
}

/**
 * Load and parse all .gitignore files in a directory tree.
 * Returns an ignore instance configured with all rules.
 */
async function loadGitignoreRules(searchPath: string, ops: BulkLoadOperations): Promise<Ignore> {
	const ig = ignore();

	// Always ignore .git directory
	ig.add(".git");

	// Try to load root .gitignore
	const rootGitignore = path.join(searchPath, ".gitignore");
	const rootContent = await ops.readGitignore(rootGitignore);
	if (rootContent) {
		ig.add(rootContent);
	}

	// Find and load nested .gitignore files
	try {
		const nestedGitignores = globSync("**/.gitignore", {
			cwd: searchPath,
			dot: true,
			absolute: true,
			ignore: ["**/node_modules/**", "**/.git/**"],
		});

		for (const gitignorePath of nestedGitignores) {
			if (gitignorePath === rootGitignore) continue;

			const content = await ops.readGitignore(gitignorePath);
			if (content) {
				// Get the directory containing this .gitignore relative to search path
				const gitignoreDir = path.dirname(gitignorePath);
				const relativeDir = path.relative(searchPath, gitignoreDir);

				// Prefix each rule with the relative directory
				const prefixedRules = content
					.split("\n")
					.map((line: string) => line.trim())
					.filter((line: string) => line && !line.startsWith("#"))
					.map((rule: string) => {
						if (rule.startsWith("/")) {
							return path.join(relativeDir, rule.slice(1));
						}
						return path.join(relativeDir, "**", rule);
					});

				ig.add(prefixedRules);
			}
		}
	} catch {
		// Ignore glob errors for nested gitignores
	}

	return ig;
}

/**
 * Check if a file is a symlink and resolve it (one level only).
 * Returns { shouldInclude: boolean, realPath: string }
 */
async function resolveSymlink(
	filePath: string,
	ops: BulkLoadOperations,
	seenRealPaths: Set<string>,
): Promise<{ shouldInclude: boolean; realPath: string }> {
	const stats = await ops.lstat(filePath);

	if (!stats.isSymbolicLink) {
		// Not a symlink, include if it's a file
		return { shouldInclude: stats.isFile, realPath: filePath };
	}

	// It's a symlink - resolve one level
	try {
		const realPath = await ops.realpath(filePath);

		// Don't follow if we've already seen this real path (prevents loops)
		if (seenRealPaths.has(realPath)) {
			return { shouldInclude: false, realPath };
		}

		// Check if the target is a file (not a directory or another symlink)
		const targetStats = await ops.lstat(realPath);
		if (targetStats.isFile && !targetStats.isSymbolicLink) {
			return { shouldInclude: true, realPath };
		}

		// Target is a directory or another symlink - don't follow
		return { shouldInclude: false, realPath };
	} catch {
		// Can't resolve symlink (broken link, etc.)
		return { shouldInclude: false, realPath: filePath };
	}
}

export function createBulkLoadTool(cwd: string, options?: BulkLoadToolOptions): AgentTool<typeof bulkLoadSchema> {
	const customOps = options?.operations;

	return {
		name: "bulk_load",
		label: "bulk_load",
		description: `Bulk load all files matching a glob pattern into context. Returns file contents with === delimiters. Uses tiktoken for accurate token counting. Respects .gitignore. Default limit: ${DEFAULT_MAX_TOKENS.toLocaleString()} tokens.`,
		parameters: bulkLoadSchema,
		execute: async (
			_toolCallId: string,
			{ glob: globPattern, path: searchDir, maxTokens }: BulkLoadToolInput,
			signal?: AbortSignal,
		) => {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const tokenBudget = maxTokens ?? DEFAULT_MAX_TOKENS;
						const ops = customOps ?? defaultBulkLoadOperations;

						// Verify search path exists and is a directory
						if (!(await ops.isDirectory(searchPath))) {
							signal?.removeEventListener("abort", onAbort);
							reject(new Error(`Path not found or not a directory: ${searchPath}`));
							return;
						}

						// Load gitignore rules
						const ig = await loadGitignoreRules(searchPath, ops);

						// Find all matching files
						const matchedFiles = await ops.glob(globPattern, searchPath, {
							ignore: ["**/node_modules/**", "**/.git/**"],
						});

						if (matchedFiles.length === 0) {
							signal?.removeEventListener("abort", onAbort);
							resolve({
								content: [{ type: "text", text: "No files found matching pattern" }],
								details: { filesLoaded: 0, filesSkipped: 0, totalTokens: 0, skippedFiles: [] },
							});
							return;
						}

						// Filter by gitignore and resolve symlinks
						const seenRealPaths = new Set<string>();
						const filesToLoad: Array<{ displayPath: string; realPath: string }> = [];

						for (const filePath of matchedFiles) {
							const relativePath = path.relative(searchPath, filePath);

							// Check gitignore
							if (ig.ignores(relativePath)) {
								continue;
							}

							// Handle symlinks (one level deep)
							const { shouldInclude, realPath } = await resolveSymlink(filePath, ops, seenRealPaths);

							if (shouldInclude) {
								seenRealPaths.add(realPath);
								filesToLoad.push({ displayPath: relativePath, realPath });
							}
						}

						if (filesToLoad.length === 0) {
							signal?.removeEventListener("abort", onAbort);
							resolve({
								content: [
									{
										type: "text",
										text: "No files found after filtering (all matched files were gitignored or invalid)",
									},
								],
								details: { filesLoaded: 0, filesSkipped: 0, totalTokens: 0, skippedFiles: [] },
							});
							return;
						}

						// Load files until we hit the token budget
						const loadedFiles: string[] = [];
						const skippedFiles: string[] = [];
						let totalTokens = 0;
						const outputParts: string[] = [];

						for (const { displayPath, realPath } of filesToLoad) {
							if (signal?.aborted) {
								throw new Error("Operation aborted");
							}

							try {
								const content = await ops.readFile(realPath);
								const fileBlock = `=== ${displayPath} ===\n${content}`;
								const blockTokens = countTokens(fileBlock);

								if (totalTokens + blockTokens <= tokenBudget) {
									outputParts.push(fileBlock);
									totalTokens += blockTokens;
									loadedFiles.push(displayPath);
								} else {
									skippedFiles.push(displayPath);
								}
							} catch {
								// Skip files we can't read (binary, permission issues, etc.)
								skippedFiles.push(`${displayPath} (read error)`);
							}
						}

						signal?.removeEventListener("abort", onAbort);

						// Build output
						let output = outputParts.join("\n\n");

						// Add summary
						const summaryParts = [`${loadedFiles.length} files`, `${totalTokens.toLocaleString()} tokens`];

						if (skippedFiles.length > 0) {
							const skippedPreview = skippedFiles.slice(0, 10).join(", ");
							const moreCount = skippedFiles.length > 10 ? ` and ${skippedFiles.length - 10} more` : "";
							summaryParts.push(
								`${skippedFiles.length} skipped (budget exceeded): ${skippedPreview}${moreCount}`,
							);
						}

						output += `\n\n[BulkLoad: ${summaryParts.join(". ")}]`;

						const details: BulkLoadToolDetails = {
							filesLoaded: loadedFiles.length,
							filesSkipped: skippedFiles.length,
							totalTokens,
							skippedFiles,
						};

						resolve({
							content: [{ type: "text", text: output }],
							details,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
	};
}

/** Default bulk_load tool using process.cwd() - for backwards compatibility */
export const bulkLoadTool = createBulkLoadTool(process.cwd());
