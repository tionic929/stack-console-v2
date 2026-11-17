//! Git branch of a folder, read from `.git/HEAD` (no git binary). Normal repos, worktrees and
//! submodules (a `.git` file with `gitdir: ...`). Reference: `main/git.js`.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct BranchInfo {
    pub branch: String,
    pub detached: bool,
    pub root: PathBuf,
    /// The HEAD file, for watching.
    pub head: PathBuf,
}

pub fn find_git_dir(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut dir = start.to_path_buf();
    for _ in 0..64 {
        let dotgit = dir.join(".git");
        if let Ok(meta) = std::fs::metadata(&dotgit) {
            if meta.is_dir() {
                return Some((dotgit, dir));
            }
            if meta.is_file()
                && let Ok(text) = std::fs::read_to_string(&dotgit)
                    && let Some(line) = text.lines().find_map(|l| l.trim().strip_prefix("gitdir:")) {
                        return Some((dir.join(line.trim()), dir));
                    }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

pub fn branch_info(folder: &Path) -> Option<BranchInfo> {
    let (git_dir, root) = find_git_dir(folder)?;
    let head = git_dir.join("HEAD");
    let text = std::fs::read_to_string(&head).ok()?;
    let text = text.trim();
    if let Some(branch) = text.strip_prefix("ref:").map(str::trim).and_then(|r| r.strip_prefix("refs/heads/")) {
        return Some(BranchInfo { branch: branch.to_string(), detached: false, root, head });
    }
    if (7..=40).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(BranchInfo { branch: text[..7].to_string(), detached: true, root, head });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_branch_worktree_and_detached() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("app/src")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feature/QP1522-login\n").unwrap();
        let info = branch_info(&repo.join("app/src")).unwrap();
        assert_eq!(info.branch, "feature/QP1522-login");
        assert!(!info.detached);
        assert_eq!(info.root, repo);

        let wt = dir.path().join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(repo.join(".git/worktrees/wt")).unwrap();
        std::fs::write(repo.join(".git/worktrees/wt/HEAD"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", repo.join(".git/worktrees/wt").display())).unwrap();
        let info = branch_info(&wt).unwrap();
        assert_eq!(info.branch, "0123456");
        assert!(info.detached);

        assert!(branch_info(dir.path()).is_none() || branch_info(dir.path()).unwrap().root != dir.path());
    }
}
