#!/usr/bin/env python3
"""Checks data/*.json against the rules in PLAN.md section 4.5.

Usage: python scripts/validate.py [data-dir]   (exit code 1 when an error is found)
Standard library only.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data"

TYPES = {"job", "quest", "train", "gear", "ap", "sp", "pq", "tip"}
PRIORITIES = {"high", "medium", "low"}
VARIANTS = {None, "one-handed", "two-handed"}
AVAILABILITY = {"live", "upcoming", "not-in-game"}

errors: list[str] = []
warnings: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def load(name: str):
    path = DATA / name
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        err(f"{name}: missing")
    except json.JSONDecodeError as e:
        err(f"{name}: invalid JSON ({e})")
    return None


def check_time(where: str, t) -> None:
    """Play-time estimates are minutes: {"min": int, "max": int, "overlap"?: bool}."""
    if t is None:
        return
    ok = isinstance(t, dict) and isinstance(t.get("min"), (int, float)) and isinstance(t.get("max"), (int, float))
    if not ok or t["min"] < 0 or t["min"] > t["max"] or t["max"] <= 0:
        err(f"{where}: bad time {t!r} (needs 0 <= min <= max, in minutes)")


HUNT_KINDS = {"kill", "drop", "find", "buy"}


def check_hunt(where: str, task: dict, maps: dict, monsters: dict) -> None:
    """hunt: where to kill or collect things, one entry per target, tied to a step (1-based)."""
    hunt = task.get("hunt")
    if hunt is None:
        return
    if not isinstance(hunt, list):
        err(f"{where}: hunt must be a list")
        return
    steps = len(task.get("steps") or [])
    for i, h in enumerate(hunt):
        hw = f"{where}/hunt[{i}]"
        if not isinstance(h, dict):
            err(f"{hw}: must be an object")
            continue
        step = h.get("step")
        if not isinstance(step, int) or not 1 <= step <= steps:
            err(f"{hw}: step {step!r} is not one of the task's {steps} steps")
        if h.get("kind") not in HUNT_KINDS:
            err(f"{hw}: bad kind '{h.get('kind')}'")
        if not h.get("what"):
            err(f"{hw}: missing what")
        if h.get("kind") == "drop" and not h.get("monsters"):
            err(f"{hw}: a drop needs the monsters that drop it")
        for ref in h.get("monsters", []) or []:
            if ref not in monsters:
                err(f"{hw}: unknown monster '{ref}'")
        for w in h.get("where", []) or []:
            if not isinstance(w, dict) or w.get("map") not in maps:
                err(f"{hw}: unknown map in where: {w!r}")
            elif "count" in w and (not isinstance(w["count"], int) or w["count"] <= 0):
                err(f"{hw}: bad count {w['count']!r}")
        if not h.get("where") and not h.get("note"):
            err(f"{hw}: needs where or a note that explains where")


def index(name: str) -> dict:
    rows = load(name)
    if rows is None:
        return {}
    if not isinstance(rows, list):
        err(f"{name}: must be a list")
        return {}
    out = {}
    for i, row in enumerate(rows):
        rid = row.get("id") if isinstance(row, dict) else None
        if not isinstance(rid, str) or not rid:
            err(f"{name}[{i}]: missing id")
            continue
        if rid in out:
            err(f"{name}: duplicate id '{rid}'")
        out[rid] = row
    return out


def main() -> int:
    maps = index("maps.json")
    monsters = index("monsters.json")
    npcs = index("npcs.json")
    items = index("items.json")

    for nid, npc in npcs.items():
        if npc.get("mapId") and npc["mapId"] not in maps:
            err(f"npcs.json '{nid}': unknown mapId '{npc['mapId']}'")

    guide = load("guide.json")
    if not isinstance(guide, dict) or not isinstance(guide.get("builds"), list):
        err("guide.json: needs a 'builds' list")
        return report(0, 0)

    total = unverified = 0
    build_ids = set()
    for build in guide["builds"]:
        bid = build.get("id")
        if bid in build_ids:
            err(f"duplicate build id '{bid}'")
        build_ids.add(bid)
        stage_ids, task_ids = set(), set()
        stages = sorted(build.get("stages", []), key=lambda s: s.get("order", 0))
        prev = None
        for stage in stages:
            sid = stage.get("id")
            where = f"{bid}/{sid}"
            if sid in stage_ids:
                err(f"{where}: duplicate stage id")
            stage_ids.add(sid)
            lf, lt = stage.get("levelFrom"), stage.get("levelTo")
            if not isinstance(lf, int) or not isinstance(lt, int) or lf > lt:
                err(f"{where}: bad level range {lf}-{lt}")
            elif prev is not None and lf != prev.get("levelTo"):
                err(f"{where}: levelFrom {lf} should equal the previous stage's levelTo {prev.get('levelTo')}")
            if stage.get("availability", "live") not in AVAILABILITY:
                err(f"{where}: bad availability '{stage.get('availability')}'")
            prev = stage
            check_time(where, stage.get("time"))

            tasks = stage.get("tasks", [])
            if tasks and not stage.get("time"):
                err(f"{where}: needs a play-time estimate (time)")
            if not tasks:
                warnings.append(f"{where}: no tasks yet")
                continue
            required_by_style = {"one-handed": 0, "two-handed": 0}
            required_variants = {"one-handed": 0, "two-handed": 0}
            for task in tasks:
                total += 1
                tid = task.get("id")
                tw = f"{where}/{tid}"
                if not tid:
                    err(f"{where}: task without id")
                    continue
                if tid in task_ids:
                    err(f"{tw}: duplicate task id in build")
                task_ids.add(tid)
                ttype = task.get("type")
                if ttype not in TYPES:
                    err(f"{tw}: bad type '{ttype}'")
                if task.get("priority", "medium") not in PRIORITIES:
                    err(f"{tw}: bad priority '{task.get('priority')}'")
                variant = task.get("variant")
                if variant not in VARIANTS:
                    err(f"{tw}: bad variant '{variant}'")
                if not task.get("titleHe"):
                    err(f"{tw}: missing titleHe")
                if ttype == "pq" and task.get("required"):
                    err(f"{tw}: pq tasks can never be required")
                if task.get("required"):
                    for style in required_by_style:
                        if variant in (None, style):
                            required_by_style[style] += 1
                    if variant in required_variants:
                        required_variants[variant] += 1
                check_time(tw, task.get("time"))
                if not task.get("sources"):
                    err(f"{tw}: needs at least one source")
                if not task.get("verified"):
                    unverified += 1
                if task.get("npc") and task["npc"] not in npcs:
                    err(f"{tw}: unknown npc '{task['npc']}'")
                for field, table, label in (("route", maps, "map"), ("maps", maps, "map"),
                                            ("monsters", monsters, "monster"), ("items", items, "item")):
                    for ref in task.get(field, []) or []:
                        if ref not in table:
                            err(f"{tw}: unknown {label} '{ref}' in {field}")
                check_hunt(tw, task, maps, monsters)
            for style, n in required_by_style.items():
                if n == 0:
                    err(f"{where}: no required task for the {style} style")
            one, two = required_variants["one-handed"], required_variants["two-handed"]
            if (one == 0) != (two == 0):
                err(f"{where}: required weapon-style tasks exist for only one style ({one} one-handed, {two} two-handed)")
    return report(total, unverified)


def report(total: int, unverified: int) -> int:
    for w in warnings:
        print(f"warning: {w}")
    for e in errors:
        print(f"error: {e}")
    print(f"{total} tasks, {unverified} with verified: false, {len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
