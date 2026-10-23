"""Convert a design-canvas (x-dc) template into a React JSX view function.

Usage: python3 dc2jsx.py <template.html> <out.jsx> <FunctionName> [startLine endLine]
The view receives the object returned by the logic class's renderVals() as `vm`.
"""
import re, sys, json
from html.parser import HTMLParser

VOID = {'input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'ellipse', 'stop'}
ATTR_MAP = {'class': 'className', 'for': 'htmlFor', 'tabindex': 'tabIndex', 'colspan': 'colSpan', 'rowspan': 'rowSpan',
            'readonly': 'readOnly', 'maxlength': 'maxLength', 'autofocus': 'autoFocus', 'viewbox': 'viewBox',
            'contenteditable': 'contentEditable', 'srcset': 'srcSet', 'crossorigin': 'crossOrigin', 'autocomplete': 'autoComplete'}
EXPR = re.compile(r'\{\{\s*(.*?)\s*\}\}')

def camel(s):
    parts = s.split('-')
    return parts[0] + ''.join(p[:1].upper() + p[1:] for p in parts[1:])

class Node:
    def __init__(self, tag, attrs):
        self.tag, self.attrs, self.children = tag, attrs, []

class P(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node('#root', [])
        self.stack = [self.root]
    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs)
        self.stack[-1].children.append(n)
        if tag not in VOID:
            self.stack.append(n)
    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag, attrs))
    def handle_endtag(self, tag):
        if tag in VOID:
            return
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return
    def handle_data(self, d):
        self.stack[-1].children.append(d)

class Conv:
    def __init__(self):
        self.roots = set()
    def expr(self, e, scope):
        e = e.strip()
        if e in ('true', 'false', 'null') or re.fullmatch(r'-?\d+(\.\d+)?', e):
            return e
        if not re.fullmatch(r'[A-Za-z_$][\w$]*(\.[\w$]+)*', e):
            raise ValueError('complex expr: ' + e)
        parts = e.split('.')
        out = parts[0] if parts[0] in scope else 'vm.' + parts[0]
        if parts[0] not in scope:
            self.roots.add(parts[0])
        for p in parts[1:]:
            out += '[%s]' % p if p.isdigit() else '?.' + p
        return out
    def interp(self, s, scope):
        """string with {{}} -> JS expression string"""
        m = EXPR.fullmatch(s.strip())
        if m and s.strip() == s:
            return self.expr(m.group(1), scope)
        pieces, last = [], 0
        for m in EXPR.finditer(s):
            pieces.append(s[last:m.start()].replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${'))
            pieces.append('${' + self.expr(m.group(1), scope) + '}')
            last = m.end()
        pieces.append(s[last:].replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${'))
        return '`' + ''.join(pieces) + '`'
    def style(self, s, scope):
        items = []
        for decl in re.split(r';(?![^(]*\))', s):
            if ':' not in decl:
                continue
            k, v = decl.split(':', 1)
            k, v = k.strip(), v.strip()
            if not k:
                continue
            key = camel(k[1:]) if k.startswith('-') else camel(k)
            if k.startswith('-'):
                key = key[:1].upper() + key[1:]
            if '{{' in v:
                val = self.interp(v, scope)
            else:
                val = json.dumps(v, ensure_ascii=False)
            items.append('%s: %s' % (json.dumps(key) if '-' in key else key, val))
        return '{{' + ', '.join(items) + '}}'
    def attrs(self, node, scope):
        out = []
        for k, v in node.attrs:
            if k.startswith('hint-') or k in ('name',) and node.tag == 'dc-import':
                continue
            v = '' if v is None else v
            if k.startswith('sc-camel-'):
                k = camel(k[len('sc-camel-'):])
            elif k.startswith('on') and node.tag != 'dc-import':
                k = 'on' + k[2:3].upper() + k[3:]
            elif node.tag == 'dc-import':
                k = camel(k)
            elif k in ATTR_MAP:
                k = ATTR_MAP[k]
            elif k.startswith('aria-') or k.startswith('data-'):
                pass
            elif '-' in k:
                k = camel(k)
            if k == 'style':
                out.append('style=' + self.style(v, scope))
            elif '{{' in v:
                out.append('%s={%s}' % (k, self.interp(v, scope)))
            elif v == '' and k in ('checked', 'disabled', 'multiple', 'selected', 'readOnly', 'autoFocus', 'hidden'):
                out.append(k)
            else:
                out.append('%s=%s' % (k, json.dumps(v, ensure_ascii=False)))
        return out
    def text(self, t, scope):
        t = re.sub(r'\s+', ' ', t)
        if not t.strip():
            return ' ' if t and False else ''
        out, last = [], 0
        for m in EXPR.finditer(t):
            lit = t[last:m.start()]
            if lit:
                out.append('{%s}' % json.dumps(lit, ensure_ascii=False))
            out.append('{%s}' % self.expr(m.group(1), scope))
            last = m.end()
        lit = t[last:]
        if lit:
            out.append('{%s}' % json.dumps(lit, ensure_ascii=False))
        return ''.join(out)
    def kids(self, node, scope, ind):
        res = []
        for c in node.children:
            s = self.text(c, scope) if isinstance(c, str) else self.node(c, scope, ind)
            if s:
                res.append(s)
        return res
    def node(self, n, scope, ind):
        pad = '  ' * ind
        if n.tag == 'sc-if':
            cond = self.interp(dict(n.attrs)['value'], scope)
            body = self.kids(n, scope, ind + 1)
            return '{(%s) ? (<>\n%s\n%s</>) : null}' % (cond, '\n'.join(pad + '  ' + b for b in body), pad)
        if n.tag == 'sc-for':
            a = dict(n.attrs)
            lst = self.interp(a['list'], scope)
            var = a.get('as', 'item')
            idx = '__i%d' % ind
            body = self.kids(n, scope | {var}, ind + 1)
            return '{(%s || []).map((%s, %s) => <React.Fragment key={%s}>\n%s\n%s</React.Fragment>)}' % (
                lst, var, idx, idx, '\n'.join(pad + '  ' + b for b in body), pad)
        tag = n.tag
        if tag.startswith('sc-raw-'):
            tag = tag[len('sc-raw-'):]
        if tag == 'dc-import':
            tag = dict(n.attrs)['name']
        attrs = self.attrs(n, scope)
        a = (' ' + ' '.join(attrs)) if attrs else ''
        body = self.kids(n, scope, ind + 1)
        if not body:
            return '<%s%s />' % (tag, a)
        if len(body) == 1 and '\n' not in body[0] and len(body[0]) < 80:
            return '<%s%s>%s</%s>' % (tag, a, body[0], tag)
        return '<%s%s>\n%s\n%s</%s>' % (tag, a, '\n'.join(pad + '  ' + b for b in body), pad, tag)

def main():
    src, out, fname = sys.argv[1], sys.argv[2], sys.argv[3]
    lines = open(src, encoding='utf-8').read().split('\n')
    if len(sys.argv) > 5:
        html = '\n'.join(lines[int(sys.argv[4]) - 1:int(sys.argv[5])])
    else:
        h = '\n'.join(lines)
        html = h[h.index('<x-dc>') + 6:h.index('</x-dc>')]
    p = P(); p.feed(html)
    c = Conv()
    body = [b for b in c.kids(p.root, set(), 2) if b.strip()]
    jsx = "import React from 'react';\nimport JalaliDatePicker from './JalaliDatePicker.jsx';\n\n" \
          "// Generated by tools/dc2jsx.py from the design template. Edit the template mapping, not by hand.\n" \
          "export default function %s({ vm }) {\n  return (<>\n    %s\n  </>);\n}\n" % (fname, '\n    '.join(body))
    open(out, 'w', encoding='utf-8').write(jsx)
    print('roots:', ' '.join(sorted(c.roots)))

main()
