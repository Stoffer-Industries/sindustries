//! Pure file-resolution helpers shared by the test runners in `crate::main`.
//!
//! Extracted from `main.rs` as part of the W36 audit A3 follow-up
//! (task `d578e547`, design `docs/specs/feature-task-main-rs-split-tech-design.md`,
//! PR-B). No I/O beyond `std::fs::read_dir`; no caller-visible behaviour
//! change. `pub(crate)` surface consumed only by `ShellTestRunner` and
//! `PytestTestRunner` (both still in `main.rs` until PR-C extracts them).

use std::path::{Path, PathBuf};

/// Directories skipped during `resolve_repo_file_by_name`'s search — build
/// artefacts and dependency trees that are large, irrelevant, and (for
/// `.git`) not meaningful to search.
pub(crate) const SEARCH_EXCLUDE_DIRS: &[&str] = &[
    ".git", "target", "node_modules", ".venv", "dist", "build",
];

/// Resolve a bare filename (e.g. `package-json-no-pnpm-pin.test.sh`) or a
/// repo-relative path cited in an AC's `testID` evidence to an absolute
/// path under `repo_root`.
///
/// Cited shell test names observed in practice (task 5baf6809) are bare
/// filenames, not paths, so a direct join isn't enough — this walks the
/// repo tree once and matches on file name. Returns an error (rather than
/// silently picking one) if zero or more than one file matches, so a
/// typo'd or ambiguous citation surfaces as a mechanical-evidence failure
/// instead of silently resolving to the wrong script — the same
/// no-silent-pass discipline `cargo_test_leaf_outcome` applies (PR #541
/// review).
pub(crate) fn resolve_repo_file_by_name(
    repo_root: &Path,
    name: &str,
) -> Result<PathBuf, String> {
    let direct = repo_root.join(name);
    if direct.is_file() {
        return Ok(direct);
    }
    if name.contains('/') {
        return Err(format!("{name} not found under {}", repo_root.display()));
    }
    let mut matches = Vec::new();
    let mut stack = vec![repo_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name();
            let file_name_str = file_name.to_string_lossy();
            if path.is_dir() {
                if !SEARCH_EXCLUDE_DIRS.contains(&file_name_str.as_ref()) {
                    stack.push(path);
                }
            } else if file_name_str == name {
                matches.push(path);
            }
        }
    }
    match matches.len() {
        0 => Err(format!(
            "no file named \"{name}\" found under {}",
            repo_root.display()
        )),
        1 => Ok(matches.remove(0)),
        n => Err(format!(
            "{n} files named \"{name}\" found under {} \u{2014} ambiguous citation",
            repo_root.display()
        )),
    }
}

/// Nearest ancestor of `start_file` (inclusive of its parent, exclusive
/// above `repo_root`) containing a `pyproject.toml`. Python test suites in
/// this repo live under per-workflow subprojects (e.g.
/// `agents/workflows/cto-craft-tweet-drafts/`), each with its own `uv`
/// environment, so `uv run pytest` must execute from that subproject
/// directory rather than the repo root.
pub(crate) fn nearest_pyproject_dir(repo_root: &Path, start_file: &Path) -> Option<PathBuf> {
    let mut dir = start_file.parent()?;
    loop {
        if dir.join("pyproject.toml").is_file() {
            return Some(dir.to_path_buf());
        }
        if dir == repo_root {
            return None;
        }
        dir = dir.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::{nearest_pyproject_dir, resolve_repo_file_by_name};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn resolve_repo_file_by_name_finds_unique_bare_name_match() {
        let root = tempdir().unwrap();
        let nested = root.path().join("infra/cloud/scripts/tests");
        fs::create_dir_all(&nested).unwrap();
        let target = nested.join("package-json-no-pnpm-pin.test.sh");
        fs::write(&target, "#!/usr/bin/env bash\nexit 0\n").unwrap();

        let resolved =
            resolve_repo_file_by_name(root.path(), "package-json-no-pnpm-pin.test.sh").unwrap();
        assert_eq!(resolved, target);
    }

    #[test]
    fn resolve_repo_file_by_name_resolves_direct_relative_path() {
        let root = tempdir().unwrap();
        let nested = root.path().join("infra/cloud/scripts/tests");
        fs::create_dir_all(&nested).unwrap();
        let target = nested.join("foo.test.sh");
        fs::write(&target, "#!/usr/bin/env bash\nexit 0\n").unwrap();

        let resolved =
            resolve_repo_file_by_name(root.path(), "infra/cloud/scripts/tests/foo.test.sh")
                .unwrap();
        assert_eq!(resolved, target);
    }

    #[test]
    fn resolve_repo_file_by_name_errors_when_not_found() {
        let root = tempdir().unwrap();
        let err = resolve_repo_file_by_name(root.path(), "does-not-exist.test.sh").unwrap_err();
        assert!(err.contains("no file named"), "unexpected error: {err}");
    }

    #[test]
    fn resolve_repo_file_by_name_errors_when_ambiguous() {
        let root = tempdir().unwrap();
        let dir_a = root.path().join("a");
        let dir_b = root.path().join("b");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        fs::write(dir_a.join("dup.test.sh"), "exit 0\n").unwrap();
        fs::write(dir_b.join("dup.test.sh"), "exit 0\n").unwrap();

        let err = resolve_repo_file_by_name(root.path(), "dup.test.sh").unwrap_err();
        assert!(err.contains("ambiguous"), "unexpected error: {err}");
    }

    #[test]
    fn resolve_repo_file_by_name_skips_excluded_dirs() {
        let root = tempdir().unwrap();
        let decoy = root.path().join("node_modules/some-pkg");
        fs::create_dir_all(&decoy).unwrap();
        fs::write(decoy.join("decoy.test.sh"), "exit 0\n").unwrap();

        let err = resolve_repo_file_by_name(root.path(), "decoy.test.sh").unwrap_err();
        assert!(err.contains("no file named"), "unexpected error: {err}");
    }

    #[test]
    fn nearest_pyproject_dir_walks_up_to_the_subproject_root() {
        let root = tempdir().unwrap();
        let project = root.path().join("agents/workflows/x");
        let tests_dir = project.join("tests");
        fs::create_dir_all(&tests_dir).unwrap();
        fs::write(project.join("pyproject.toml"), "[project]\n").unwrap();
        let test_file = tests_dir.join("test_y.py");
        fs::write(&test_file, "def test_z(): pass\n").unwrap();

        let found = nearest_pyproject_dir(root.path(), &test_file).unwrap();
        assert_eq!(found, project);
    }

    #[test]
    fn nearest_pyproject_dir_returns_none_when_absent() {
        let root = tempdir().unwrap();
        let tests_dir = root.path().join("agents/workflows/x/tests");
        fs::create_dir_all(&tests_dir).unwrap();
        let test_file = tests_dir.join("test_y.py");
        fs::write(&test_file, "def test_z(): pass\n").unwrap();

        assert!(nearest_pyproject_dir(root.path(), &test_file).is_none());
    }
}
