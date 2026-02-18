import { classifyJobScheduleType, classifyUserAutomationIntent } from '../talk-chat';

describe('talk chat automation intent policy', () => {
  test('classifies explicit recurring/scheduled intent', () => {
    const mode = classifyUserAutomationIntent({
      message: 'Please run this daily at 9am',
      likelyActionRequest: true,
      toolsEnabledForTurn: true,
      availableToolCount: 3,
      hasPolicyBlockedTools: false,
    });
    expect(mode).toBe('recurring_explicit');
  });

  test('classifies ambiguous follow-up intent', () => {
    const mode = classifyUserAutomationIntent({
      message: 'Can you follow up later?',
      likelyActionRequest: true,
      toolsEnabledForTurn: true,
      availableToolCount: 3,
      hasPolicyBlockedTools: false,
    });
    expect(mode).toBe('ambiguous_followup');
  });

  test('classifies immediate blocked when tools cannot execute now', () => {
    const mode = classifyUserAutomationIntent({
      message: 'Create a Google doc now',
      likelyActionRequest: true,
      toolsEnabledForTurn: false,
      availableToolCount: 0,
      hasPolicyBlockedTools: true,
    });
    expect(mode).toBe('immediate_blocked');
  });

  test('classifies immediate executable when action can run now', () => {
    const mode = classifyUserAutomationIntent({
      message: 'Create a Google doc now',
      likelyActionRequest: true,
      toolsEnabledForTurn: true,
      availableToolCount: 2,
      hasPolicyBlockedTools: false,
    });
    expect(mode).toBe('immediate_executable');
  });

  test('classifies none when not action-oriented', () => {
    const mode = classifyUserAutomationIntent({
      message: 'Thanks for the explanation',
      likelyActionRequest: false,
      toolsEnabledForTurn: true,
      availableToolCount: 2,
      hasPolicyBlockedTools: false,
    });
    expect(mode).toBe('none');
  });
});

describe('job schedule type classifier', () => {
  test('classifies event schedules', () => {
    expect(classifyJobScheduleType('on #gamemakers')).toBe('event');
  });

  test('classifies one-off schedules', () => {
    expect(classifyJobScheduleType('in 5m')).toBe('once');
    expect(classifyJobScheduleType('at 3pm')).toBe('once');
  });

  test('classifies recurring schedules', () => {
    expect(classifyJobScheduleType('every 2h')).toBe('recurring');
    expect(classifyJobScheduleType('0 9 * * *')).toBe('recurring');
  });
});
