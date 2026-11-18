#!/bin/bash
# Grades paper.md and annotations.md in the project directory (needs internet for Crossref and arXiv).
cd /app && python3 /tests/grade_paper.py /app/paper.md /tests/topic.json
