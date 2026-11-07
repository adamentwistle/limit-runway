// Pin to sidebar, from the overlay. It reads the shown layout as it is now, so the button says what the window shows.
// A layout that already has a runway block shows or hides it. One without gets a block at the right of the row that holds
// the terminals, beside the side panel, if the layout is the person's own. Herdr's shipped layouts can't take new blocks, so
// there the button isn't offered. No Herdr imports here, so it can be tested.
export const SHIPPED = ["main", "terminals", "win98"];

const BLOCK = { type: "block", size: { px: 340 }, min: 320, max: 640, content: { mod: "runway" } };

const kids = (node) => (Array.isArray(node?.children) ? node.children : []);
const holdsTerminals = (node) => node?.content?.tab !== undefined || kids(node).some(holdsTerminals);

// The nodes from the root down to the first one that passes, or null.
function pathTo(node, passes, trail = []) {
  if (!node || typeof node !== "object") return null;
  const here = [...trail, node];
  if (passes(node)) return here;
  for (const child of kids(node)) {
    const found = pathTo(child, passes, here);
    if (found) return found;
  }
  return null;
}

function ids(node, into = new Set()) {
  if (node?.id) into.add(node.id);
  for (const child of kids(node)) ids(child, into);
  return into;
}

function freeId(tree, base) {
  const taken = ids(tree);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// A copy with the block in it, or null if there's no row holding the terminals.
export function withBlock(tree) {
  const copy = JSON.parse(JSON.stringify(tree));
  let row = null;
  const visit = (node) => {
    if (node.type === "row" && kids(node).some(holdsTerminals)) row = node;
    kids(node).forEach(visit);
  };
  visit(copy);
  if (!row) return null;
  row.children.push({ id: freeId(copy, "runway"), ...BLOCK });
  return copy;
}

// What the button would do: null when there's nothing it can do, else whether it's pinned and the commands that flip it.
export function pinPlan(tree, layoutName) {
  if (!tree || typeof tree !== "object") return null;
  const mine = !SHIPPED.includes(String(layoutName ?? ""));
  const path = pathTo(tree, (node) => node?.content?.mod === "runway");
  if (!path) {
    const placed = mine ? withBlock(tree) : null;
    return placed ? { pinned: false, commands: [["layout.set", { layout: placed }]] } : null;
  }
  const block = path.at(-1), pinned = path.every((node) => !node.hidden);
  if (!block.id) return null;
  if (pinned) return { pinned, commands: [["layout.hide", { id: block.id }]] };
  const hidden = path.filter((node) => node.hidden);
  if (hidden.some((node) => !node.id)) return null;
  return { pinned, commands: hidden.map((node) => ["layout.show", { id: node.id }]) };
}
