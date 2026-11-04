import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { parseSkillMarkdown } = require('../../electron/learner.cjs')._internals

const sample = `---
name: pdf-report
description: Turn a PDF into a reviewed summary report.
allowed-tools: doc_extract, fs_write
---

# PDF report

Read the source first, then write the summary.

Steps:
1. tool: doc_extract {"path":"C:/docs/report.pdf"}
2. tool: fs_write {"path":"C:/docs/summary.md"}

## Success check

The summary file exists and quotes the source.

## Avoid
- Do not edit the source PDF.
- Do not invent figures.
`

describe('SKILL.md parsing', () => {
  it('reads frontmatter, steps, sections and guide', () => {
    const skill = parseSkillMarkdown(sample)
    expect(skill.name).toBe('pdf-report')
    expect(skill.when).toBe('Turn a PDF into a reviewed summary report.')
    expect(skill.allowedTools).toEqual(['doc_extract', 'fs_write'])
    expect(skill.steps).toEqual([
      { tool: 'doc_extract', args: { path: 'C:/docs/report.pdf' }, ok: true },
      { tool: 'fs_write', args: { path: 'C:/docs/summary.md' }, ok: true },
    ])
    expect(skill.successCheck).toMatch(/summary file exists/)
    expect(skill.avoid).toEqual(['Do not edit the source PDF.', 'Do not invent figures.'])
    expect(skill.guide).toContain('Read the source first')
    expect(skill.guide).not.toMatch(/^\s*1\. tool:/m)
  })

  it('accepts a fenced orvex-steps JSON block', () => {
    const skill = parseSkillMarkdown(`---
name: notes
description: Write a note file from a prompt.
---
# Notes
\`\`\`orvex-steps
[{"tool":"fs_write","args":{"path":"C:/notes.txt"}}]
\`\`\`
Follow the note format.
`)
    expect(skill.steps).toHaveLength(1)
    expect(skill.steps[0].tool).toBe('fs_write')
    expect(skill.guide).not.toContain('orvex-steps')
  })

  it('falls back to the H1 and first paragraph without frontmatter', () => {
    const skill = parseSkillMarkdown('# Weekly report\n\nBuild a weekly status report from the run log.\n')
    expect(skill.name).toBe('Weekly report')
    expect(skill.when).toMatch(/weekly status report/)
    expect(skill.steps).toEqual([])
    expect(skill.guide).toContain('Weekly report')
  })

  it('rejects empty text, broken YAML and missing names', () => {
    expect(() => parseSkillMarkdown('')).toThrow(/Paste a SKILL.md/)
    expect(() => parseSkillMarkdown('---\nname: [broken\n---\nbody')).toThrow(/frontmatter/)
    expect(() => parseSkillMarkdown('---\ndescription: A skill with no name.\n---\nplain')).toThrow(/needs a name/)
  })

  it('caps steps at 20', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${i + 1}. tool: fs_list {"path":"C:/${i}"}`).join('\n')
    const skill = parseSkillMarkdown(`---\nname: many\ndescription: A skill with many explicit steps.\n---\n${lines}`)
    expect(skill.steps).toHaveLength(20)
  })
})
