"""Allowlisted rich text, with images referenced by index instead of HTML URLs."""

from html import escape
from html.parser import HTMLParser

TAGS = {"p", "div", "br", "strong", "b", "h1", "h2", "h3", "em", "i", "ul", "ol", "li"}
BLOCKED = {"script", "style", "iframe", "object", "svg", "math", "template"}


class RichMarkup(HTMLParser):
    def __init__(self, images, embed=False):
        super().__init__(convert_charrefs=True)
        self.images, self.embed = images, embed
        self.output, self.stack = [], []
        self.blocked = 0

    def handle_starttag(self, tag, attrs):
        if tag in BLOCKED:
            self.blocked += 1
            return
        if self.blocked:
            return
        if tag == "img":
            try:
                index = int(dict(attrs).get("data-image-index", "-1"))
            except (TypeError, ValueError):
                return
            if 0 <= index < len(self.images):
                if self.embed:
                    self.output.append(
                        f'<img alt="事项插图" src="{escape(self.images[index], quote=True)}">'
                    )
                else:
                    self.output.append(f'<img data-image-index="{index}">')
        elif tag in TAGS:
            tag = {"b": "strong", "i": "em"}.get(tag, tag)
            self.output.append(f"<{tag}>")
            if tag != "br":
                self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in BLOCKED:
            self.blocked = max(0, self.blocked - 1)
            return
        if self.blocked:
            return
        tag = {"b": "strong", "i": "em"}.get(tag, tag)
        if tag in self.stack:
            while self.stack:
                closing = self.stack.pop()
                self.output.append(f"</{closing}>")
                if closing == tag:
                    break

    def handle_data(self, value):
        if not self.blocked:
            self.output.append(escape(value))

    def finish(self):
        self.output.extend(f"</{tag}>" for tag in reversed(self.stack))
        return "".join(self.output)


def sanitize_markup(markup, images, embed=False):
    if not isinstance(markup, str) or len(markup) > 150000:
        raise ValueError("格式化正文过长或格式不正确")
    parser = RichMarkup(images, embed)
    parser.feed(markup)
    parser.close()
    return parser.finish()
