import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import talk_server as server
from test_talk_server import FakeTrace


class TurnCoordinationTests(unittest.TestCase):
    def setUp(self):
        self.session = 'coordination-' + self.id()
        server._reset_session(self.session)
        self.agent = SimpleNamespace(provider=SimpleNamespace(name='mock', transcribe=Mock(return_value='wait')),
                                     messages=[{'role': 'system', 'content': 'Hotel instructions'}], last_sources=[])
        self.lock = threading.Lock()
        self.trace = FakeTrace()
        self.patches = [
            patch('talk_server._get_session', return_value=(self.agent, self.lock)),
            patch('talk_server._trace', return_value=self.trace),
            patch('talk_server._finish_response', side_effect=lambda agent, trace, reply, action, **extra:
                  dict(reply=reply, action=action, **extra)),
            patch('talk_server._browser_tts_payload', return_value={'ttsBackend': 'browser'}),
        ]
        for item in self.patches:
            item.start()
        self.agent.respond = self.respond

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        server._reset_session(self.session)

    def respond(self, text, trace=None):
        self.agent.messages.extend([{'role': 'user', 'content': text}, {'role': 'assistant', 'content': 'Prepared reply'}])
        return 'Prepared reply', None

    def test_preview_does_not_wait_for_an_inflight_agent_request(self):
        result = []
        with self.lock:
            thread = threading.Thread(target=lambda: result.append(server._voice_agent_reply(
                b'preview', 'audio/wav', self.session, 'check', True, check_only=True)))
            thread.start()
            thread.join(.5)
            completed_without_lock = not thread.is_alive()
        thread.join(1)
        self.assertTrue(completed_without_lock)
        self.assertTrue(result[0]['inputConfirmed'])
        self.assertEqual(len(self.agent.messages), 1)

    def test_superseding_reasoning_keeps_user_and_tool_results_but_removes_unheard_reply(self):
        entered, released = threading.Event(), threading.Event()
        def respond(text, trace=None):
            self.agent.messages.extend([{'role': 'user', 'content': text},
                {'role': 'assistant', 'tool_calls': [{'id': 'booking', 'type': 'function'}]},
                {'role': 'tool', 'tool_call_id': 'booking', 'content': 'Booking succeeded'}])
            entered.set()
            self.assertTrue(released.wait(1))
            self.agent.messages.append({'role': 'assistant', 'content': 'Unheard booking reply'})
            return 'Unheard booking reply', None
        self.agent.respond = respond
        results = []
        thread = threading.Thread(target=lambda: results.append(server._agent_reply('Book it', self.session, 'old', 1)))
        thread.start()
        self.assertTrue(entered.wait(1))
        server._playback_feedback(self.session, 'old', 'discarded', 2)
        released.set()
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0]['ignoreReason'], 'superseded')
        self.assertNotIn('Unheard booking reply', [message.get('content') for message in self.agent.messages])
        self.assertIn('Booking succeeded', [message.get('content') for message in self.agent.messages])
        server._browser_tts_payload.assert_not_called()

    def test_late_generation_is_rejected_before_history_or_tools(self):
        self.agent.respond = Mock(side_effect=self.respond)
        server._playback_feedback(self.session, 'old', 'discarded', 3)
        result = server._agent_reply('Old input', self.session, 'old', 2)
        self.assertEqual(result['ignoreReason'], 'superseded')
        self.agent.respond.assert_not_called()

    def test_interrupted_reply_is_not_assumed_heard_by_the_next_model_turn(self):
        server._agent_reply('First question', self.session, 'first', 1)
        server._playback_feedback(self.session, 'first', 'interrupted', 2)
        seen = []
        def respond(text, trace=None):
            seen.extend(message.get('content', '') for message in self.agent.messages)
            return self.respond(text, trace)
        self.agent.respond = respond
        server._agent_reply('Correction', self.session, 'next', 2)
        self.assertNotIn('Prepared reply', seen)
        self.assertTrue(any('Do not assume' in value for value in seen))

    def test_interrupted_history_includes_the_approximate_portion_already_played(self):
        server._agent_reply('First question', self.session, 'first', 1)
        server._playback_feedback(self.session, 'first', 'interrupted', 2, 7000, 10000)
        server._apply_delivery_feedback(self.agent, self.session)
        note = self.agent.messages[-1]['content']
        self.assertIn('about 70% of its audio', note)
        self.assertIn('Approximate portion already spoken', note)
        self.assertIn('Prepared', note)
        self.assertIn('Do not repeat the approximate portion unless asked', note)

    def test_playback_feedback_rejects_invalid_partial_position(self):
        with self.assertRaises(ValueError):
            server._playback_feedback(self.session, 'first', 'interrupted', 1, True, 10000)
        with self.assertRaises(ValueError):
            server._playback_feedback(self.session, 'first', 'interrupted', 1, 5000, None)

    def test_completed_playback_feedback_records_its_reference_end(self):
        server._register_delivery(self.agent, self.session, 'first', 'Prepared reply', 1)
        server._playback_feedback(self.session, 'first', 'completed', 1, 4200, 4200)
        record = server._response_deliveries[self.session]['first']
        self.assertEqual(record['state'], 'completed')
        self.assertEqual(record['heard_through_ms'], 4200)
        self.assertEqual(record['playback_duration_ms'], 4200)

    def test_recovered_output_completion_restores_its_delivered_history(self):
        server._agent_reply('Question', self.session, 'first', 1)
        server._playback_feedback(self.session, 'first', 'interrupted')
        server._apply_delivery_feedback(self.agent, self.session)
        self.assertIn('Playback note', self.agent.messages[-1]['content'])
        server._playback_feedback(self.session, 'first', 'completed')
        server._apply_delivery_feedback(self.agent, self.session)
        self.assertEqual(self.agent.messages[-1]['content'], 'Prepared reply')
        server._playback_feedback(self.session, 'first', 'interrupted')
        server._apply_delivery_feedback(self.agent, self.session)
        self.assertEqual(self.agent.messages[-1]['content'], 'Prepared reply')

    def test_superseding_during_render_also_discards_unheard_response(self):
        def render(agent, trace, reply):
            server._playback_feedback(self.session, 'old', 'discarded', 2)
            return {'audioBase64': 'never-deliver'}
        server._browser_tts_payload.side_effect = render
        result = server._agent_reply('Question', self.session, 'old', 1)
        self.assertEqual(result['ignoreReason'], 'superseded')
        self.assertNotIn('audioBase64', result)
        self.assertEqual([message['role'] for message in self.agent.messages], ['system', 'user'])


if __name__ == '__main__':
    unittest.main()
