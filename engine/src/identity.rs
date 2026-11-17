//! Project identity: a palette colour plus an icon (a stack mark or 1-2 letters). Automatic unless the
//! project stores its own choice; worked out on every read, never saved. Reference: `main/identity.js`.

use crate::model::Project;
use crate::paths::natural_cmp;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// Names match the `--id-<name>` tokens in `src/tokens.css`.
pub const PALETTE: [&str; 5] = ["purple", "pink", "cyan", "brown", "sand"];
const NOT_STACKS: [&str; 2] = ["generic", "terminal"];

fn hash(text: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for c in text.chars() {
        let mut buf = [0u16; 2];
        let unit = c.encode_utf16(&mut buf)[0];
        h ^= unit as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

fn icon_key_ok(s: &str) -> bool {
    let body = s.strip_prefix("g:").unwrap_or(s);
    (1..=32).contains(&body.len()) && body.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn letters_ok(s: &str) -> bool {
    (1..=2).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

pub fn initials(name: &str) -> String {
    let name = if name.is_empty() { "?" } else { name };
    // camelCase -> camel Case, then anything else becomes a space
    let mut spaced = String::new();
    let mut prev: Option<char> = None;
    for c in name.chars() {
        if let Some(p) = prev
            && p.is_ascii_lowercase() && c.is_ascii_uppercase() {
                spaced.push(' ');
            }
        spaced.push(if c.is_ascii_alphanumeric() || c == ' ' || c == '_' || c == '-' { c } else { ' ' });
        prev = Some(c);
    }
    let words: Vec<&str> = spaced.split(|c: char| c.is_whitespace() || c == '_' || c == '-').filter(|w| !w.is_empty()).collect();
    let raw: String = if words.len() >= 2 {
        words[0].chars().take(1).chain(words[1].chars().take(1)).collect()
    } else {
        words.first().copied().unwrap_or("?").chars().take(2).collect()
    };
    raw.to_uppercase()
}

fn distinct_letters(name: &str, taken: &HashSet<String>) -> String {
    let first = initials(name);
    if !taken.contains(&first) {
        return first;
    }
    let letters: Vec<char> = name.to_uppercase().chars().filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).collect();
    for i in 1..letters.len() {
        let pick: String = [letters[0], letters[i]].iter().collect();
        if !taken.contains(&pick) {
            return pick;
        }
    }
    first
}

fn text(p: &Project, field: &str) -> Option<String> {
    p.extra.get(field).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The stack most of its commands use; none -> letters.
pub fn auto_icon(p: &Project) -> Option<String> {
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for c in &p.commands {
        if let Some(icon) = c.extra.get("icon").and_then(Value::as_str).filter(|s| !s.is_empty() && !NOT_STACKS.contains(s)) {
            if !counts.contains_key(icon) {
                order.push(icon.to_string());
            }
            *counts.entry(icon.to_string()).or_default() += 1;
        }
    }
    let mut best: Option<(&String, usize)> = None;
    for k in &order {
        let n = counts[k];
        if best.is_none_or(|(_, bn)| n > bn) {
            best = Some((k, n));
        }
    }
    best.map(|(k, _)| k.clone())
}

/// `group_of(project)` names the list it shows in. In one list the first five get five different
/// colours; past five, each still differs from the two above it (in name order).
pub fn identities(projects: &[Project], group_of: impl Fn(&Project) -> String) -> HashMap<String, Value> {
    let mut groups: Vec<(String, Vec<&Project>)> = Vec::new();
    for p in projects {
        let g = group_of(p);
        match groups.iter_mut().find(|(k, _)| *k == g) {
            Some((_, list)) => list.push(p),
            None => groups.push((g, vec![p])),
        }
    }
    let mut out = HashMap::new();
    for (_, list) in groups {
        let chosen = |p: &Project| text(p, "color").filter(|c| PALETTE.contains(&c.as_str()));
        let mut used: HashSet<String> = list.iter().filter_map(|p| chosen(p)).collect();
        let mut used_letters: HashSet<String> = HashSet::new();
        let mut recent: Vec<String> = Vec::new();
        let mut sorted = list.clone();
        sorted.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        for p in sorted {
            let start = (hash(&p.id) as usize) % PALETTE.len();
            let ring: Vec<&str> = (0..PALETTE.len()).map(|i| PALETTE[(start + i) % PALETTE.len()]).collect();
            let auto = ring
                .iter()
                .find(|c| !used.contains(**c))
                .or_else(|| ring.iter().find(|c| !recent.iter().any(|r| r == **c)))
                .unwrap_or(&ring[0])
                .to_string();
            let color = chosen(p).unwrap_or_else(|| auto.clone());
            used.insert(color.clone());
            recent.insert(0, color.clone());
            recent.truncate(2);
            let auto_letters = distinct_letters(&p.name, &used_letters);
            let icon_field = text(p, "icon");
            let mono_field = text(p, "mono").filter(|m| letters_ok(m));
            let mono = if icon_field.as_deref() == Some("letters") { mono_field.unwrap_or_else(|| auto_letters.clone()) } else { auto_letters.clone() };
            used_letters.insert(mono.clone());
            let stack = auto_icon(p);
            let icon = match icon_field.as_deref() {
                Some("letters") => None,
                Some(i) if icon_key_ok(i) => Some(i.to_string()),
                _ => stack.clone(),
            };
            let custom = text(p, "color").is_some() || icon_field.is_some();
            out.insert(
                p.id.clone(),
                json!({ "color": color, "icon": icon, "mono": mono, "custom": custom,
                        "auto": { "color": auto, "icon": stack, "mono": auto_letters } }),
            );
        }
    }
    out
}

/// A choice from the picker: `{ color: name|null, icon: key|"letters"|null, mono: "XY" }`.
pub struct IdentityChoice {
    pub color: Option<String>,
    pub icon: Option<String>,
    pub mono: Option<String>,
}

pub fn validate(input: &Value) -> Result<IdentityChoice, String> {
    let s = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
    let color = s("color").filter(|c| !c.is_empty());
    let icon = s("icon").filter(|c| !c.is_empty());
    if let Some(c) = &color
        && !PALETTE.contains(&c.as_str()) {
            return Err("Unknown colour.".into());
        }
    if let Some(i) = &icon
        && i != "letters" && !icon_key_ok(i) {
            return Err("Unknown icon.".into());
        }
    let mono = s("mono").map(|m| m.trim().to_uppercase()).unwrap_or_default();
    let letters = icon.as_deref() == Some("letters");
    if letters && !letters_ok(&mono) {
        return Err("Use one or two letters or digits.".into());
    }
    Ok(IdentityChoice { color, icon, mono: letters.then_some(mono) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proj(id: &str, name: &str) -> Project {
        Project { id: id.into(), name: name.into(), ..Default::default() }
    }

    #[test]
    fn hash_matches_javascript() {
        // Values computed with hash() from main/identity.js under Node
        assert_eq!(hash("shop"), 2823282857);
        assert_eq!(hash("a"), 3826002220);
        assert_eq!(hash("é😀x"), 3418354361);
    }

    #[test]
    fn identities_match_javascript() {
        let ps: Vec<Project> = serde_json::from_value(json!([
            {"id": "p0", "name": "Project 0"},
            {"id": "shop", "name": "Shop", "color": "cyan"},
            {"id": "blog", "name": "blog", "commands": [{"id": "1", "icon": "vite"}, {"id": "2", "icon": "vite"}, {"id": "3", "icon": "laravel"}]},
            {"id": "x", "name": "Smartlab", "icon": "letters", "mono": "ZZ"},
            {"id": "y", "name": "SmartLaboratory"}
        ])).unwrap();
        let got = identities(&ps, |_| "g".into());
        // Output of identities() from main/identity.js for the same input
        let want: HashMap<String, Value> = serde_json::from_str(r#"{"blog":{"color":"pink","icon":"vite","mono":"BL","custom":false,"auto":{"color":"pink","icon":"vite","mono":"BL"}},"p0":{"color":"brown","icon":null,"mono":"P0","custom":false,"auto":{"color":"brown","icon":null,"mono":"P0"}},"shop":{"color":"cyan","icon":null,"mono":"SH","custom":true,"auto":{"color":"sand","icon":null,"mono":"SH"}},"x":{"color":"purple","icon":null,"mono":"ZZ","custom":true,"auto":{"color":"purple","icon":null,"mono":"SM"}},"y":{"color":"sand","icon":null,"mono":"SL","custom":false,"auto":{"color":"sand","icon":null,"mono":"SL"}}}"#).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn initials_and_letters() {
        assert_eq!(initials("automart-admin"), "AA");
        assert_eq!(initials("SmartLab"), "SL");
        assert_eq!(initials("shop"), "SH");
        assert_eq!(initials(""), "?");
        let taken: HashSet<String> = ["SM".to_string()].into();
        assert_eq!(distinct_letters("Smartlab", &taken), "SA");
    }

    #[test]
    fn five_projects_five_colours() {
        let ps: Vec<Project> = (0..5).map(|i| proj(&format!("p{i}"), &format!("Project {i}"))).collect();
        let ids = identities(&ps, |_| "g".into());
        let colours: HashSet<String> = ids.values().map(|v| v["color"].as_str().unwrap().to_string()).collect();
        assert_eq!(colours.len(), 5);
    }

    #[test]
    fn validation() {
        assert!(validate(&json!({"color": "red"})).is_err());
        assert!(validate(&json!({"icon": "letters", "mono": "abc"})).is_err());
        let ok = validate(&json!({"icon": "letters", "mono": "ab"})).unwrap();
        assert_eq!(ok.mono.as_deref(), Some("AB"));
        assert!(validate(&json!({"icon": "g:rocket", "color": null})).is_ok());
    }
}
