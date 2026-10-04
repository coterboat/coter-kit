// The question card /waiting shows, and the answers the home dashboard leaves: node --test tests/waiting.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitingCard, cardAnswer, outsideAnswer, waitingOptions, LATER } from '../hooks/waiting.js'

test('a card shows the question with its link, the ref as header, its own answers with the first marked, then Later', () => {
  const card = waitingCard({ id: 'qa', ref: 'Q9', text: 'Which font?', link: 'https://claude.ai/artifact/f1', options: ['Inter', 'Geist'] }, { project: 'work' })
  assert.deepEqual(card, { question: 'Which font? · https://claude.ai/artifact/f1', header: 'Q9', options: ['Inter (Recommended)', 'Geist', LATER] })
  assert.equal(cardAnswer('Inter (Recommended)'), 'Inter')
})

test('an item without answers of its own gets yes and no; another project is named; no ref reads Waiting', () => {
  const card = waitingCard({ id: 'qb', project: 'wallstbets', text: 'Approve the stop-loss rule' }, { project: 'work' })
  assert.deepEqual(card, { question: '[wallstbets] Approve the stop-loss rule', header: 'Waiting', options: ['Yes, or done', 'No, drop it', LATER] })
})

test('answers read from a note are checked again: a note from another machine cannot overfill the card', () => {
  const card = waitingCard({ id: 'qc', text: 'Pick one', options: ['A', 'B', 'C', 'D', 'E'] }, {})
  assert.deepEqual(card.options, ['A (Recommended)', 'B', 'C', LATER])
  assert.equal(waitingOptions(['Later', 'later', 'Only']), undefined)
  assert.equal(waitingOptions('A, B'), undefined)
})

test("a dashboard answer counts only as a whole version 1 file about its own item", () => {
  assert.equal(outsideAnswer({ v: 1, id: 'qa', answer: '  Hold  (Recommended) ' }, 'qa'), 'Hold')
  assert.equal(outsideAnswer({ v: 1, id: 'qb', answer: 'Yes' }, 'qa'), '')
  assert.equal(outsideAnswer({ v: 2, id: 'qa', answer: 'Yes' }, 'qa'), '')
  assert.equal(outsideAnswer({ v: 1, id: 'qa', answer: 7 }, 'qa'), '')
  assert.equal(outsideAnswer([{ v: 1, id: 'qa', answer: 'Yes' }], 'qa'), '')
  assert.equal(outsideAnswer(null, 'qa'), '')
  assert.equal(outsideAnswer({ v: 1, id: 'qa', answer: 'x'.repeat(500) }, 'qa').length, 300)
})
