#!/usr/bin/env python3
"""Build MainItems.js from a broodjes menu PDF.

Usage:
    py scrape_menu_pdf.py <pdf-url> [--out DIR]

Downloads the PDF at <pdf-url>, extracts its text and writes <out>/MainItems.js
using the nested tree the lunch app already expects. Stdlib plus pypdf.

Prompt: replace the Thuisbezorgd scraper with a PDF menu source.
Reason: the menu now comes from a Wevers Food PDF, so the desktop launcher and
the GitHub Action both regenerate MainItems.js from that PDF instead of a site.
"""
import argparse
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'application/pdf,*/*;q=0.8',
}
# Prompt: report scan progress as structured events the desktop app can draw.
# Reason: the launcher already renders phases, a menu tree and a summary, so the
# new generator emits the same events (prefix must match main.cjs).
EVENT_PREFIX = '@@TECHKES@@ '

# Prompt: mirror the PDF's own sections.
# Reason: the printed menu groups its broodjes under these headings, and the
# first column image is reused for every item that has no photo of its own.
CATEGORY_HEADERS = {
    'the colds': 'The colds',
    'the best sandwich in town': 'The best sandwich in town',
    'the basics': 'The basics',
    'the hots': 'The hots',
    'als je echt tegen pittig kan': 'Als je echt tegen pittig kan',
    'onze nieuwe sterren': 'Onze nieuwe sterren',
    'drinks': 'Drinks',
    'wraps': 'Wraps',
}
CATEGORY_ORDER = [
    'The colds', 'The best sandwich in town', 'The basics', 'Drinks',
    'The hots', 'Als je echt tegen pittig kan', 'Onze nieuwe sterren', 'Wraps',
]
CATEGORY_IMAGES = {
    'The colds': './img/koude broodjes.jpg',
    'The best sandwich in town': './img/bufkes specials.jpg',
    'The basics': './img/koude broodjes.jpg',
    'Drinks': './img/koude dranken.jpg',
    'The hots': './img/warme broodjes.jpg',
    'Als je echt tegen pittig kan': './img/bufkes specials.jpg',
    'Onze nieuwe sterren': './img/bufkes specials.jpg',
    'Wraps': './img/wraps.jpg',
}

# Prompt: reuse an existing photo when the menu item matches one.
# Reason: the img/ folder was scanned for the previous menu; only some names
# still line up, and every other item falls back to its category image.
ITEM_IMAGES = {
    'Gerookte zalm': 'broodje gerookte zalm met kruidenkaas.jpg',
    'Caprese': 'broodje mozzarella tomaat.jpg',
    'Broodje carpaccio': 'broodje rundercarpaccio.jpg',
    'Gezond': 'broodje gezond.jpg',
    'Brie': 'broodje brie met vijgenjam.jpg',
    'Filet americain': 'broodje filet americain.jpg',
    'Filet americain martino': 'broodje filet americain martino.jpg',
    'Ei-salade': 'broodje huisgemaakte eiersalade met spek.jpg',
    'Tonijnsalade': 'broodje huisgemaakte tonijnsalade.jpg',
    'Warme bal': 'broodje bufkesbal.jpg',
    'Kip krokantje': 'broodje kipkrokant.jpg',
    'Asian style': 'broodje oosterse kip.jpg',
    'Spare rib': 'broodje sticky bbq.jpg',
    'Werrem sjink': 'broodje werrem sjink.jpg',
    'Redbull / chocomel': 'red bull energy drink 250ml.jpg',
    'Coca cola - coca cola zero': 'coca-cola 500ml.jpg',
    'Ice tea regular / green / peach': 'fuze tea black tea peach hibiscus 400ml.jpg',
    'Fanta / fanta cassis': 'fanta orange 500ml.jpg',
    'Pellegrino / evian': 'chaudfontaine blauw 500ml.jpg',
    'Sappen': 'verse jus d orange groot.jpg',
    'Wrap gerookte zalm': 'wrap gerookte zalm.jpg',
}

# Prompt: the PDF prints a few items without the leading dots used by the rest.
# Reason: those featured items have their name on one line and the price at the
# end of the description, so they are matched by name and placed explicitly.
FEATURED_ITEMS = {
    'broodje sint pieter': 'The best sandwich in town',
    'broodje carpaccio': 'The colds',
    'bruudsje sjérp gehak': 'Als je echt tegen pittig kan',
    'saigon chicken': 'Onze nieuwe sterren',
    'rib eye de luxe': 'Onze nieuwe sterren',
}

# Prompt: give every sandwich a bread choice, half stokbrood by default.
# Reason: the PDF sells a half stokbrood for +EUR 1,00 on every broodje except
# the sint pieter, which is specifically excluded on the printed menu.
SANDWICH_CATEGORIES = {
    'The colds', 'The best sandwich in town', 'The basics', 'The hots',
    'Als je echt tegen pittig kan', 'Onze nieuwe sterren',
}
NO_HALF = {'Broodje sint pieter'}
HALF_ONLY = {'Half stokbrood spek en ei'}
# Prompt: label the full-size option Standaard, matching the app's existing wording.
# Reason: the printed menu only names the half stokbrood, and the old menu used
# Standaard for the plain choice, so both bread options read consistently.
FULL_LABEL = 'Standaard'
BREAD_IMAGE = './img/keuze broodje.jpg'
LOGO_IMAGE = './img/logo.png'

PRICE_RE = re.compile(r'€\s*([0-9]+[.,][0-9]{2})')
NOTE_RE = re.compile(r'\([^)]*\)')


def emit(event, **fields):
    """Emit one JSON progress event on stdout, prefixed with a sentinel."""
    fields['event'] = event
    try:
        print(EVENT_PREFIX + json.dumps(fields, ensure_ascii=False), flush=True)
    except Exception:
        pass


def fail(message):
    emit('error', message=message)
    sys.exit('Error: ' + message)


def fetch_pdf(url):
    request = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        fail('could not download the PDF (HTTP %s) from %s' % (error.code, url))
    except urllib.error.URLError as error:
        fail('could not download the PDF: %s' % error.reason)


def pdf_text(data):
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            fail('pypdf is required to read the PDF (pip install pypdf)')
    reader = PdfReader(io.BytesIO(data))
    return '\n'.join((page.extract_text() or '') for page in reader.pages)


def split_last_price(line):
    """Split into text and price using the last amount on the line."""
    matches = list(PRICE_RE.finditer(line))
    if not matches:
        return line.strip(), None
    last = matches[-1]
    return (line[:last.start()] + ' ' + line[last.end():]).strip(), last.group(1)


def clean_name(raw):
    name = NOTE_RE.sub(' ', raw.strip().strip('.').strip())
    return re.sub(r'\s+', ' ', name).strip(' -')


def nice_name(name):
    if name.isupper():
        name = name.capitalize()
    return name[:1].upper() + name[1:]


def category_for(name, current):
    if name.lower().startswith('wrap '):
        return 'Wraps'
    return current


def parse_items(text):
    """Return menu items in printed order as {name, price, category}."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    items = []
    current = None
    index = 0
    while index < len(lines):
        raw = lines[index]
        low = raw.lower()
        if low in CATEGORY_HEADERS:
            current = CATEGORY_HEADERS[low]
            index += 1
            continue
        if raw.startswith('....'):
            body = raw[4:]
            name_part, price = split_last_price(body)
            name = nice_name(clean_name(name_part))
            items.append({'name': name, 'price': price, 'category': category_for(name, current)})
            index += 1
            continue
        if low in FEATURED_ITEMS:
            price = None
            cursor = index + 1
            while cursor < len(lines):
                nxt = lines[cursor]
                if nxt.startswith('....') or nxt.lower() in CATEGORY_HEADERS:
                    break
                if price is None:
                    _, found = split_last_price(nxt)
                    price = found
                cursor += 1
            items.append({'name': nice_name(clean_name(raw)), 'price': price,
                          'category': FEATURED_ITEMS[low]})
            index += 1
            continue
        index += 1
    return items


def item_image(name, category):
    filename = ITEM_IMAGES.get(name)
    if filename:
        return './img/' + filename
    return CATEGORY_IMAGES[category]


def quoted(value):
    return "'" + value + "'"


def build_tree(items):
    """Group items into the AllMainItems tree, adding the bread-choice level."""
    grouped = {}
    for item in items:
        grouped.setdefault(item['category'], []).append(item)
    tree = {'IMG': quoted(LOGO_IMAGE)}
    for category in CATEGORY_ORDER:
        entries = grouped.get(category)
        if not entries:
            continue
        node = {'IMG': quoted(CATEGORY_IMAGES[category])}
        for item in entries:
            name = item['name']
            image = quoted(item_image(name, category))
            if category in SANDWICH_CATEGORIES:
                choices = {}
                if name not in HALF_ONLY:
                    choices[FULL_LABEL] = [{'IMG': quoted(BREAD_IMAGE)}]
                if name not in NO_HALF:
                    choices['Half stokbrood'] = [{'IMG': quoted(BREAD_IMAGE)}]
                node[name] = [dict({'IMG': image}, **choices)]
            else:
                node[name] = [{'IMG': image}]
        tree[category] = [node]
    return tree


def build_js(tree):
    return 'AllMainItems = ' + json.dumps(tree, ensure_ascii=False, indent='\t') + ';\n'


def tree_event(tree):
    """Shape the tree for the launcher's menu preview."""
    categories = []
    for name, value in tree.items():
        if name == 'IMG':
            continue
        node = value[0]
        entries = []
        for key, child in node.items():
            if key == 'IMG':
                continue
            inner = child[0]
            groups = [group for group in inner.keys() if group != 'IMG']
            entries.append({'name': key, 'optionGroups': groups})
        categories.append({'name': name, 'itemCount': len(entries), 'items': entries})
    return categories


def warn_missing_images(tree, out):
    count = 0
    seen = set()
    for value in tree.values():
        if not isinstance(value, list) or not value:
            continue
        stack = [value[0]]
        while stack:
            node = stack.pop()
            for key, child in node.items():
                if key == 'IMG':
                    seen.add(str(child).strip("'"))
                    continue
                stack.extend(child)
    for path in sorted(seen):
        filename = path.replace('./img/', '', 1)
        if not os.path.exists(os.path.join(out, 'img', filename)):
            count += 1
            emit('warning', message='missing image: %s' % filename)
    return count


def main():
    parser = argparse.ArgumentParser(description='Build MainItems.js from a menu PDF URL.')
    parser.add_argument('url', help='URL of the menu PDF, e.g. https://.../menu.pdf')
    parser.add_argument('--out', default='.', help='output directory (default: current)')
    args = parser.parse_args()

    if not args.url.lower().split('?')[0].endswith('.pdf'):
        fail('not a PDF URL: %s' % args.url)

    started = time.time()
    emit('phase_start', phase='fetch', label='Downloading menu PDF')
    data = fetch_pdf(args.url)
    emit('progress', phase='fetch', detail='PDF downloaded', done=1, total=1)
    emit('phase_done', phase='fetch', elapsed=round(time.time() - started, 1))

    parse_started = time.time()
    emit('phase_start', phase='parse', label='Reading the menu')
    items = parse_items(pdf_text(data))
    if not items:
        fail('no menu items were found in the PDF')
    tree = build_tree(items)
    emit('progress', phase='parse', detail='%d items' % len(items), done=1, total=1)
    emit('phase_done', phase='parse', elapsed=round(time.time() - parse_started, 1))

    write_started = time.time()
    emit('phase_start', phase='write', label='Writing MainItems.js')
    destination = os.path.join(args.out, 'MainItems.js')
    with open(destination, 'w', encoding='utf-8') as handle:
        handle.write(build_js(tree))
    emit('progress', phase='write', detail='MainItems.js', done=1, total=1)
    emit('phase_done', phase='write', elapsed=round(time.time() - write_started, 1))

    categories = tree_event(tree)
    emit('tree', categories=categories)
    groups = sum(len(entry['optionGroups']) for category in categories for entry in category['items'])
    emit('summary', categories=len(categories), items=len(items), groups=groups,
         images=warn_missing_images(tree, args.out), elapsed=round(time.time() - started, 1))
    emit('done', output=destination)


if __name__ == '__main__':
    main()
