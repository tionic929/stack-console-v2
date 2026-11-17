//! Split a project into one project per folder group, or combine sibling projects into one. Moving
//! a command changes the folder its relative working directory resolves against, so every move
//! rewrites it; what can't be kept (a "start after" link across projects, a .env outside the new
//! folder) is reported first. Reference: `main/regroup.js`.

use crate::importer::short_folder_labels;
use crate::model::{Command, Database, Project};
use crate::paths::{basename, command_folder, contains, is_drive_root, key, normalize, relative, within};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{MAIN_SEPARATOR, Path};

fn within_s(child: &str, root: &str) -> bool {
    within(Path::new(child), Path::new(root))
}

/// Working directory for `folder` inside a project at `base`: relative when inside, else absolute.
pub fn working_dir_for(folder: Option<&str>, base: &str) -> String {
    match folder {
        None => String::new(),
        Some(f) if within_s(f, base) => relative(base, f),
        Some(f) => f.to_string(),
    }
}

fn env_warning(cmd: &Command, folder: Option<&str>, new_base: &str, project_name: &str) -> Option<String> {
    let env_file = cmd.env_file()?;
    let file = normalize(&Path::new(folder.unwrap_or(new_base)).join(&env_file));
    let inside = [folder, Some(new_base)].into_iter().flatten().any(|root| file.starts_with(normalize(Path::new(root))));
    (!inside).then(|| format!("{}: its .env file ({env_file}) is outside {project_name}'s folder, so it will be ignored.", cmd.display_name))
}

pub fn unique_id(base: &str, taken: &mut HashSet<String>) -> String {
    let collapsed: String = base.split_whitespace().collect::<Vec<_>>().join("-");
    let mut slug: String = collapsed
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        .collect();
    if slug.is_empty() {
        slug = "project".into();
    }
    let mut id = slug.clone();
    let mut n = 2;
    while taken.contains(&id) {
        id = format!("{slug}-{n}");
        n += 1;
    }
    taken.insert(id.clone());
    id
}

struct Group {
    name: String,
    folder: String,
    commands: Vec<Command>,
}

fn split_groups(project: &Project) -> Result<(Vec<Group>, Vec<String>), String> {
    let base = project.base_dir().ok_or("This project has no folder.")?.to_string();
    let mut groups: Vec<Group> = Vec::new();
    for c in &project.commands {
        let folder = command_folder(project, c);
        let mut name = String::new();
        if let Some(f) = folder.as_deref().filter(|f| within_s(f, &base)) {
            name = relative(&base, f).split(['/', '\\']).next().unwrap_or("").to_string();
        }
        match groups.iter_mut().find(|g| g.name.to_lowercase() == name.to_lowercase()) {
            Some(g) => g.commands.push(c.clone()),
            None => groups.push(Group {
                folder: if name.is_empty() { base.clone() } else { Path::new(&base).join(&name).to_string_lossy().into_owned() },
                name,
                commands: vec![c.clone()],
            }),
        }
    }
    if groups.iter().filter(|g| !g.name.is_empty()).count() < 1 || groups.len() < 2 {
        return Err("All its services run in one folder, so there is nothing to split.".into());
    }
    let group_of: HashMap<&str, usize> =
        groups.iter().enumerate().flat_map(|(i, g)| g.commands.iter().map(move |c| (c.id.as_str(), i))).collect();
    let mut warnings = Vec::new();
    for (gi, g) in groups.iter().enumerate() {
        for c in &g.commands {
            if let Some(dep) = c.start_after().and_then(|d| project.command(&d))
                && group_of.get(dep.id.as_str()) != Some(&gi) {
                    warnings.push(format!(
                        "{} starts after {}. Projects can't wait on each other, so this link will be removed.",
                        c.display_name, dep.display_name
                    ));
                }
            let gname = if g.name.is_empty() { &project.name } else { &g.name };
            if let Some(w) = env_warning(c, command_folder(project, c).as_deref(), &g.folder, gname) {
                warnings.push(w);
            }
        }
    }
    Ok((groups, warnings))
}

pub fn split_preview(project: &Project) -> Value {
    match split_groups(project) {
        Err(e) => json!({ "ok": false, "error": e }),
        Ok((groups, warnings)) => json!({
            "ok": true,
            "keeps": groups.iter().any(|g| g.name.is_empty()),
            "groups": groups.iter().map(|g| json!({
                "name": if g.name.is_empty() { &project.name } else { &g.name },
                "folder": g.folder, "stays": g.name.is_empty(), "commands": g.commands.len(),
            })).collect::<Vec<_>>(),
            "warnings": warnings,
        }),
    }
}

fn drop_start_after_outside(mut c: Command, group: &[Command]) -> Command {
    if let Some(dep) = c.start_after()
        && !group.iter().any(|d| d.id == dep) {
            c.extra.remove("startAfter");
        }
    c
}

/// Moved runtime keys: (from project, command) -> (to project, command).
pub type Moves = Vec<((String, String), (String, String))>;

pub fn apply_split(db: &mut Database, project_id: &str) -> Result<(Vec<String>, Moves), String> {
    let index = db.projects.iter().position(|p| p.id == project_id).ok_or("Unknown project.")?;
    let project = db.projects[index].clone();
    let (groups, _) = split_groups(&project)?;
    let mut taken: HashSet<String> = db.projects.iter().map(|p| p.id.clone()).collect();
    let mut moved = Vec::new();
    let mut created = Vec::new();
    let mut fresh = Vec::new();
    for g in groups.iter().filter(|g| !g.name.is_empty()) {
        let id = unique_id(&g.name, &mut taken);
        let commands = g
            .commands
            .iter()
            .map(|c| {
                let folder = command_folder(&project, c);
                let mut copy = c.clone();
                copy.working_directory = Some(working_dir_for(folder.as_deref(), &g.folder));
                moved.push(((project.id.clone(), c.id.clone()), (id.clone(), c.id.clone())));
                drop_start_after_outside(copy, &g.commands)
            })
            .collect();
        fresh.push(Project { id: id.clone(), name: g.name.clone(), base_directory: Some(g.folder.clone()), commands, ..Default::default() });
        created.push(id);
    }
    if let Some(stay) = groups.iter().find(|g| g.name.is_empty()) {
        db.projects[index].commands = stay.commands.iter().map(|c| drop_start_after_outside(c.clone(), &stay.commands)).collect();
        db.projects.splice(index + 1..index + 1, fresh);
    } else {
        let first = fresh[0].id.clone();
        db.projects.splice(index..index + 1, fresh);
        if db.active_project == project.id {
            db.active_project = first;
        }
    }
    Ok((created, moved))
}

/// Folder label for a service whose name appears more than once ("Dev (admin-api)").
fn folder_labeller(list: &[&Project]) -> impl Fn(&Project, &Command) -> String {
    let name = |p: &Project, c: &Command| basename(&command_folder(p, c).unwrap_or_else(|| p.base_dir().unwrap_or("").to_string()));
    let mut all: Vec<String> = Vec::new();
    for p in list {
        for c in &p.commands {
            let n = name(p, c);
            if !all.contains(&n) {
                all.push(n);
            }
        }
    }
    let labels = short_folder_labels(&all);
    move |p: &Project, c: &Command| {
        let n = name(p, c);
        labels.get(&n).cloned().unwrap_or(n)
    }
}

pub fn common_folder(folders: &[&str]) -> Option<String> {
    let parts: Vec<Vec<String>> = folders
        .iter()
        .map(|f| normalize(Path::new(f)).to_string_lossy().split(['/', '\\']).map(str::to_string).collect())
        .collect();
    let mut out: Vec<String> = Vec::new();
    for (i, seg) in parts[0].iter().enumerate() {
        if parts.iter().all(|p| p.get(i).is_some_and(|s| s.to_lowercase() == seg.to_lowercase())) {
            out.push(seg.clone());
        } else {
            break;
        }
    }
    if out.is_empty() {
        return None;
    }
    let joined = out.join(std::path::MAIN_SEPARATOR_STR);
    if joined.is_empty() {
        return Some(MAIN_SEPARATOR.to_string()); // the filesystem root on Unix
    }
    if joined.len() == 2 && joined.ends_with(':') {
        return Some(format!("{joined}{MAIN_SEPARATOR}"));
    }
    Some(joined)
}

/// Projects that could be combined with `project`: same parent folder, or one inside the other.
pub fn combine_candidates<'a>(db: &'a Database, project: &Project, root_paths: &[String]) -> Vec<&'a Project> {
    let Some(base) = project.base_dir() else { return Vec::new() };
    let parent = key(&crate::paths::dirname(base));
    let roots: HashSet<String> = root_paths.iter().map(|r| key(r)).collect();
    let pk = key(base);
    db.projects
        .iter()
        .filter(|p| p.id != project.id && !p.flag("archived"))
        .filter(|p| {
            let Some(b) = p.base_dir() else { return false };
            let bk = key(b);
            !roots.contains(&bk) && (key(&crate::paths::dirname(b)) == parent || contains(&pk, &bk) || contains(&bk, &pk))
        })
        .collect()
}

pub fn combine_plan(db: &Database, ids: &[String], root_paths: &[String]) -> Result<Value, String> {
    let list: Vec<&Project> = ids.iter().filter_map(|id| db.project(id)).collect();
    if list.len() < 2 {
        return Err("Pick at least two projects.".into());
    }
    if list.iter().any(|p| p.base_dir().is_none()) {
        return Err("Every project needs a folder.".into());
    }
    let folders: Vec<&str> = list.iter().map(|p| p.base_dir().unwrap()).collect();
    let base = common_folder(&folders).filter(|b| !is_drive_root(b)).ok_or("These projects are on different drives or only share a drive.")?;
    if root_paths.iter().any(|r| key(r) == key(&base)) {
        return Err(format!(
            "These projects only share {base}, your projects folder. Combine projects inside one folder, like automart."
        ));
    }
    let mut names: HashMap<&str, usize> = HashMap::new();
    for p in &list {
        for c in &p.commands {
            *names.entry(c.display_name.as_str()).or_default() += 1;
        }
    }
    let label = folder_labeller(&list);
    let mut renames = Vec::new();
    for p in &list {
        for c in &p.commands {
            if names[c.display_name.as_str()] > 1 {
                renames.push(format!("{} → {} ({})", c.display_name, c.display_name, label(p, c)));
            }
        }
    }
    Ok(json!({
        "ok": true, "base": base, "name": basename(&base),
        "projects": list.iter().map(|p| json!({ "id": p.id, "name": p.name, "commands": p.commands.len() })).collect::<Vec<_>>(),
        "commands": list.iter().map(|p| p.commands.len()).sum::<usize>(),
        "renames": renames, "warnings": [],
    }))
}

fn random_suffix() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    format!("{:04x}", n & 0xffff)
}

pub fn apply_combine(db: &mut Database, ids: &[String], name: Option<&str>, root_paths: &[String]) -> Result<(String, Moves), String> {
    let plan = combine_plan(db, ids, root_paths)?;
    let base = plan["base"].as_str().unwrap().to_string();
    let list: Vec<Project> = ids.iter().filter_map(|id| db.project(id).cloned()).collect();
    let refs: Vec<&Project> = list.iter().collect();
    let label = folder_labeller(&refs);
    let mut dup: HashMap<String, usize> = HashMap::new();
    for p in &list {
        for c in &p.commands {
            *dup.entry(c.display_name.clone()).or_default() += 1;
        }
    }
    let keep_id = list[0].id.clone();
    let mut used: HashSet<String> = HashSet::new();
    let mut moved = Vec::new();
    let mut commands = Vec::new();
    for p in &list {
        let mut id_map: HashMap<String, String> = HashMap::new();
        for c in &p.commands {
            let mut id = c.id.clone();
            while used.contains(&id) {
                id = format!("{}_{}", c.id, random_suffix());
            }
            used.insert(id.clone());
            id_map.insert(c.id.clone(), id);
        }
        for c in &p.commands {
            let mut copy = c.clone();
            copy.id = id_map[&c.id].clone();
            copy.working_directory = Some(working_dir_for(command_folder(p, c).as_deref(), &base));
            if let Some(dep) = c.start_after() {
                copy.extra.insert("startAfter".into(), json!(id_map.get(&dep).cloned().unwrap_or(dep)));
            }
            if dup[&c.display_name] > 1 {
                copy.display_name = format!("{} ({})", c.display_name, label(p, c));
            }
            if p.id != keep_id || c.id != copy.id {
                moved.push(((p.id.clone(), c.id.clone()), (keep_id.clone(), copy.id.clone())));
            }
            commands.push(copy);
        }
    }
    let pinned = list.iter().any(|p| p.flag("pinned"));
    let keep = db.project_mut(&keep_id).unwrap();
    keep.name = name.map(str::trim).filter(|n| !n.is_empty()).map(|n| n.chars().take(80).collect()).unwrap_or_else(|| plan["name"].as_str().unwrap().to_string());
    keep.base_directory = Some(base);
    keep.commands = commands;
    if pinned {
        keep.extra.insert("pinned".into(), json!(true));
    }
    let drop: HashSet<&String> = list[1..].iter().map(|p| &p.id).collect();
    db.projects.retain(|p| !drop.contains(&p.id));
    if drop.contains(&db.active_project) {
        db.active_project = keep_id.clone();
    }
    Ok((keep_id, moved))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(id: &str, name: &str, wd: &str) -> Command {
        Command { id: id.into(), display_name: name.into(), command: "x".into(), working_directory: Some(wd.into()), ..Default::default() }
    }

    #[test]
    fn split_and_combine_round_trip() {
        let d = tempfile::tempdir().unwrap();
        let base = d.path().join("lms").to_string_lossy().into_owned();
        let mut api = cmd("api", "Dev", "backend");
        api.extra.insert("startAfter".into(), json!("web"));
        let mut db = Database::default();
        db.projects.push(Project {
            id: "lms".into(),
            name: "LMS".into(),
            base_directory: Some(base.clone()),
            commands: vec![api, cmd("web", "Dev", "frontend"), cmd("q", "Queue", "backend")],
            ..Default::default()
        });
        let preview = split_preview(&db.projects[0]);
        assert_eq!(preview["groups"].as_array().unwrap().len(), 2);
        assert!(preview["warnings"][0].as_str().unwrap().contains("starts after"));
        let (created, moved) = apply_split(&mut db, "lms").unwrap();
        assert_eq!(created, vec!["backend", "frontend"]);
        assert_eq!(moved.len(), 3);
        assert_eq!(db.projects.len(), 2);
        let backend = db.project("backend").unwrap();
        assert_eq!(backend.base_dir(), Some(Path::new(&base).join("backend").to_string_lossy().as_ref()));
        assert_eq!(backend.commands[0].working_directory.as_deref(), Some(""));
        assert!(backend.commands[0].start_after().is_none(), "link across projects removed");

        let (keep, _) = apply_combine(&mut db, &["backend".into(), "frontend".into()], None, &[]).unwrap();
        assert_eq!(keep, "backend");
        let p = db.project("backend").unwrap();
        assert_eq!(p.name, "lms");
        assert_eq!(p.base_dir(), Some(base.as_str()));
        let names: Vec<&str> = p.commands.iter().map(|c| c.display_name.as_str()).collect();
        assert_eq!(names, vec!["Dev (backend)", "Queue", "Dev (frontend)"]);
        assert_eq!(p.commands[0].working_directory.as_deref(), Some("backend"));
    }

    #[test]
    fn unique_ids() {
        let mut taken: HashSet<String> = ["shop".to_string()].into();
        assert_eq!(unique_id("Shop", &mut taken), "shop-2");
        assert_eq!(unique_id("My App!", &mut taken), "my-app");
        assert_eq!(unique_id("!!", &mut taken), "project");
    }
}
