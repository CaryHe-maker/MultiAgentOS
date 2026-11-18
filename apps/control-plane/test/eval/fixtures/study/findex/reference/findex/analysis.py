"""Tokenising and stemming (spec section 1)."""
import re

STOPWORDS = frozenset(
    'a an and are as at be by for from in is it of on or the to with'.split()
)
WORD = re.compile(r'[a-z0-9]+')


def stem(word):
    if word.endswith('sses'):
        return word[:-2]
    if word.endswith('ies') and len(word) > 4:
        return word[:-3] + 'y'
    if word.endswith('s') and not word.endswith('ss') and len(word) > 3:
        return word[:-1]
    if word.endswith('ing') and len(word) > 5:
        return word[:-3]
    if word.endswith('ed') and len(word) > 4:
        return word[:-2]
    return word


def analyze(text):
    """The terms of a text, in order, without stopwords."""
    return [stem(word) for word in WORD.findall(text.lower()) if word not in STOPWORDS]
