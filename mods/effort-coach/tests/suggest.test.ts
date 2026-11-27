import { expect, test } from 'claude-code/testing'

import { isWorthAsking, suggest } from '../hooks/suggest'

test('a quick prompt gets low, a big job xhigh, most prompts nothing', () => {
  const level = (text: string) => suggest(text)?.level ?? null
  // Quick.
  expect(level('thanks!')).toBe('low')
  expect(level('ok cool')).toBe('low')
  expect(level("what's the difference between mean and median?")).toBe('low')
  expect(level('rename fig3.py to figure3_pdi.py')).toBe('low')
  // Careful thinking.
  expect(level('debug why the size plot is empty')).toBe('high')
  expect(level('review chapter 2 for consistency')).toBe('high')
  // A big job.
  expect(level('refactor the analysis pipeline and debug the failing tests across the repo')).toBe('xhigh')
  expect(level('plan and implement a new figure layout for every file in the results folder')).toBe('xhigh')
  // No strong signal: left alone.
  expect(level('add a legend to the scatter plot')).toBe(null)
  expect(level('make the line thicker and blue')).toBe(null)
  expect(level('/compact')).toBe(null)
})

test('it only asks when the gap is two levels or more', () => {
  expect(isWorthAsking({ level: 'low', why: '' }, 'high')).toBe(true)
  expect(isWorthAsking({ level: 'low', why: '' }, 'medium')).toBe(false)
  expect(isWorthAsking({ level: 'xhigh', why: '' }, 'medium')).toBe(true)
  expect(isWorthAsking({ level: 'xhigh', why: '' }, 'high')).toBe(false)
  expect(isWorthAsking({ level: 'high', why: '' }, 'low')).toBe(true)
})
