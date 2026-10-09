import { marked } from 'marked';
import DOMPurify from 'dompurify';

const caches = new WeakMap();
function compatible(current, next) {
  return current.nodeType === next.nodeType && (current.nodeType !== Node.ELEMENT_NODE || current.nodeName === next.nodeName);
}
// Reconcile the changing block. Keep paragraphs, list items, code and text nodes alive.
function patchChildren(parent, source) {
  const desired = [...source.childNodes];
  for (let index = 0; index < desired.length; index++) {
    const next = desired[index];
    const current = parent.childNodes[index];
    if (!current) { parent.append(next.cloneNode(true)); continue; }
    if (!compatible(current, next)) { parent.replaceChild(next.cloneNode(true), current); continue; }
    if (current.nodeType === Node.TEXT_NODE) {
      if (current.data !== next.data) {
        if (next.data.startsWith(current.data)) current.appendData(next.data.slice(current.data.length));
        else current.data = next.data;
      }
    } else if (current.nodeType === Node.ELEMENT_NODE) {
      for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
      for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
      patchChildren(current, next);
    }
  }
  while (parent.childNodes.length > desired.length) parent.lastChild.remove();
}

export function renderMarkdown(body, text) {
  let cache = caches.get(body);
  if (!cache) { body.replaceChildren(); cache = { blocks: [], links: '' }; caches.set(body, cache); }
  const tokens = marked.lexer(text);
  const links = JSON.stringify(tokens.links);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let block = cache.blocks[index];
    if (!block) {
      const node = document.createElement('div'); node.className = 'md-block';
      body.append(node); block = { node, raw: undefined }; cache.blocks.push(block);
    }
    // Previously parsed blocks do no Markdown parsing or DOM work.
    if (block.raw === token.raw && cache.links === links) continue;
    const single = [token]; single.links = tokens.links;
    const fragment = document.createElement('template');
    fragment.innerHTML = DOMPurify.sanitize(marked.parser(single), { FORBID_TAGS: ['img'], FORBID_ATTR: ['style'] });
    patchChildren(block.node, fragment.content);
    block.raw = token.raw;
  }
  while (cache.blocks.length > tokens.length) cache.blocks.pop().node.remove();
  cache.links = links;
}
