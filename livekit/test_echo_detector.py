import base64
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

from io import BytesIO
from pathlib import Path
import unittest
import wave

import numpy as np
from echo_detector import residual_audio
from speech_detector import classify_audio, _decode_pcm
import talk_server as server
from test_talk_server import FakeTrace


def wav(samples):
    output = BytesIO()
    with wave.open(output, 'wb') as stream:
        stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(16000)
        stream.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())
    return output.getvalue()


class AcousticEchoTests(unittest.TestCase):
    def test_delayed_attenuated_echo_is_removed_without_cloud_transcription(self):
        reference = (Path(__file__).parent / 'test_audio/synthetic_tamil_16k.wav').read_bytes()
        samples = np.frombuffer(_decode_pcm(reference), dtype='<i2').astype(np.float32) / 32768
        microphone = wav(samples[800:8800] * .15)
        result = residual_audio(microphone, reference, 75)
        self.assertIsNotNone(result)
        clean, evidence = result
        self.assertGreater(evidence['correlation'], .99)
        self.assertAlmostEqual(evidence['offsetMs'], 50, delta=1)
        self.assertEqual(classify_audio(clean)['voicedMs'], 0)

    def test_quiet_no_mixed_with_echo_survives_residual_speech_detection(self):
        reference = (Path(__file__).parent / 'test_audio/synthetic_tamil_16k.wav').read_bytes()
        caller = (Path(__file__).parent / 'test_audio/synthetic_no_16k.wav').read_bytes()
        spoken = np.frombuffer(_decode_pcm(reference), dtype='<i2').astype(np.float32) / 32768
        voice = np.frombuffer(_decode_pcm(caller), dtype='<i2').astype(np.float32) / 32768
        voice = np.pad(voice, (0, max(0, len(spoken) - len(voice))))[:len(spoken)]
        clean, evidence = residual_audio(wav(spoken * .3 + voice * .1), reference, 0)
        self.assertGreater(evidence['correlation'], .9)
        self.assertGreater(classify_audio(clean)['voicedMs'], 0)

    def test_unrelated_speech_is_not_changed(self):
        folder = Path(__file__).parent / 'test_audio'
        self.assertIsNone(residual_audio((folder / 'synthetic_no_16k.wav').read_bytes(),
                                        (folder / 'synthetic_tamil_16k.wav').read_bytes(), 0))


    def test_small_background_noise_is_not_amplified_into_speech(self):
        reference = (Path(__file__).parent / 'test_audio/synthetic_tamil_16k.wav').read_bytes()
        spoken = np.frombuffer(_decode_pcm(reference), dtype='<i2').astype(np.float32) / 32768
        noise = np.random.default_rng(7).normal(0, .0003, len(spoken)).astype(np.float32)
        clean, evidence = residual_audio(wav(spoken * .25 + noise), reference, 0)
        self.assertLessEqual(evidence['residualGain'], 4)
        self.assertEqual(classify_audio(clean)['voicedMs'], 0)

    def test_truncated_playback_echo_with_silence_tail_is_removed(self):
        reference = (Path(__file__).parent / 'test_audio/synthetic_tamil_16k.wav').read_bytes()
        spoken = np.frombuffer(_decode_pcm(reference), dtype='<i2').astype(np.float32) / 32768
        offset = 1600  # 100 ms into the response when capture begins.
        end = min(11200, len(spoken))  # Playback is interrupted near 700 ms.
        microphone = np.zeros(2 * 16000, dtype=np.float32)
        echo = spoken[offset:end] * .25
        microphone[:len(echo)] = echo
        result = residual_audio(wav(microphone), reference, 100, end / 16)
        self.assertIsNotNone(result)
        clean, evidence = result
        self.assertTrue(evidence['truncatedPlayback'])
        self.assertGreater(evidence['correlation'], .99)
        self.assertLess(evidence['residualEnergyFraction'], .01)
        self.assertEqual(classify_audio(clean)['voicedMs'], 0)

    def test_caller_speech_after_playback_stop_survives_echo_subtraction(self):
        reference = (Path(__file__).parent / 'test_audio/synthetic_tamil_16k.wav').read_bytes()
        caller = (Path(__file__).parent / 'test_audio/synthetic_no_16k.wav').read_bytes()
        spoken = np.frombuffer(_decode_pcm(reference), dtype='<i2').astype(np.float32) / 32768
        voice = np.frombuffer(_decode_pcm(caller), dtype='<i2').astype(np.float32) / 32768
        offset, end = 1600, min(11200, len(spoken))
        microphone = np.zeros(3 * 16000, dtype=np.float32)
        echo = spoken[offset:end] * .25
        microphone[:len(echo)] = echo
        caller_start = len(echo)
        microphone[caller_start:caller_start + len(voice)] += voice * .12
        clean, evidence = residual_audio(wav(microphone), reference, 100, end / 16)
        self.assertTrue(evidence['truncatedPlayback'])
        self.assertGreater(classify_audio(clean)['voicedMs'], 0)


class PlaybackReferenceRoutingTests(unittest.TestCase):
    def setUp(self):
        self.session = 'reference-' + self.id()
        self.reference = (Path(__file__).parent / 'test_audio/synthetic_tamil_16k.wav').read_bytes()
        self.spoken = np.frombuffer(_decode_pcm(self.reference), dtype='<i2').astype(np.float32) / 32768
        self.create = Mock(return_value=SimpleNamespace(text='No.', segments=[]))
        self.agent = SimpleNamespace(provider=SimpleNamespace(name='groq', stt_model='whisper-large-v3-turbo',
            client=SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=self.create)))),
            respond=Mock())
        server._remember_audio(self.session, 'playing', {'audioBase64': base64.b64encode(self.reference).decode()})
        self.patches = [patch('talk_server._get_session', return_value=(self.agent, threading.Lock())),
            patch('talk_server._trace', return_value=FakeTrace()),
            patch('talk_server._finish_response', side_effect=lambda *args, **extra: extra)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        server._reset_session(self.session)

    def check(self, audio, reference='playing'):
        return server._voice_agent_reply(audio, 'audio/wav', self.session, 'check', True,
            check_only=True, reference_id=reference, playback_offset_ms=0)

    def test_echo_is_rejected_before_transcription_even_if_latest_reply_changed(self):
        server._remember_spoken(self.session, 'An unheard, different response')
        result = self.check(wav(self.spoken * .25))
        self.assertEqual(result['ignoreReason'], 'probable_playback_echo')
        self.create.assert_not_called()
        self.agent.respond.assert_not_called()

    def test_empty_correlated_playback_residual_is_not_boosted_into_a_caller(self):
        evidence = {'correlation': .99999, 'residualEnergyFraction': .00001,
                    'offsetMs': 80, 'residualGain': 4.0}
        with patch('talk_server._playback_residual', return_value=(self.reference, evidence)), \
             patch('talk_server._speech_evidence') as vad:
            result = self.check(wav(self.spoken * .25))
        self.assertEqual(result['ignoreReason'], 'probable_playback_echo')
        self.assertEqual(result['echoEvidence'], evidence)
        vad.assert_not_called()
        self.create.assert_not_called()
        self.agent.respond.assert_not_called()

    def test_quiet_short_answer_below_two_percent_energy_still_gets_speech_checked(self):
        server._remember_spoken(self.session, 'Which room would you like?')
        evidence = {'correlation': .9958, 'residualEnergyFraction': .008302,
                    'offsetMs': 2000, 'residualGain': 4.0}
        self.create.return_value = SimpleNamespace(text='No.', segments=[])
        caller = (Path(__file__).parent / 'test_audio/synthetic_no_16k.wav').read_bytes()
        with patch('talk_server._playback_residual', return_value=(caller, evidence)):
            result = self.check(wav(self.spoken * .25))
        self.assertTrue(result['inputConfirmed'])
        self.create.assert_called_once()
        self.agent.respond.assert_not_called()

    def test_speech_like_playback_residual_still_rejects_matching_echo_text(self):
        spoken = 'Thanks for calling Aurora Hotel reservations. How can I help?'
        server._remember_spoken(self.session, spoken)
        self.create.return_value = SimpleNamespace(text=spoken, segments=[])
        evidence = {'correlation': .9781, 'residualEnergyFraction': .043327,
                    'offsetMs': -317.3, 'residualGain': 3.53}
        with patch('talk_server._playback_residual', return_value=(self.reference, evidence)):
            result = self.check(wav(self.spoken * .25))
        self.assertEqual(result['ignoreReason'], 'probable_playback_echo')
        self.assertFalse(result.get('inputConfirmed', False))
        self.agent.respond.assert_not_called()

    def test_correlated_loud_numeric_playback_fragment_is_not_confirmed_as_caller(self):
        spoken = 'The Accessible Queen is $189 per night.'
        server._remember_spoken(self.session, spoken)
        self.create.return_value = SimpleNamespace(text='$89.', segments=[])
        evidence = {'correlation': .8765, 'residualEnergyFraction': .231797,
                    'offsetMs': 7467.1, 'residualGain': 1.0}
        with patch('talk_server._playback_residual', return_value=(self.reference, evidence)):
            result = self.check(wav(self.spoken * .25))
        self.assertEqual(result['ignoreReason'], 'probable_playback_echo')
        self.assertFalse(result.get('inputConfirmed', False))
        self.agent.respond.assert_not_called()

    def test_quiet_numeric_caller_correction_survives_playback_correlation(self):
        spoken = 'The Accessible Queen is $189 per night.'
        server._remember_spoken(self.session, spoken)
        self.create.return_value = SimpleNamespace(text='$89.', segments=[])
        evidence = {'correlation': .9643, 'residualEnergyFraction': .07011,
                    'offsetMs': 0, 'residualGain': 4.0}
        with patch('talk_server._playback_residual', return_value=(self.reference, evidence)):
            result = self.check(wav(self.spoken * .25))
        self.assertTrue(result['inputConfirmed'])
        self.assertFalse(result.get('ignored', False))

    def test_correlated_price_echo_with_added_or_changed_digit_is_not_a_caller(self):
        server._remember_spoken(self.session, 'An Accessible Queen is $199 per night.')
        evidence = {'correlation': .8851, 'residualEnergyFraction': .216511,
                    'offsetMs': 14320.9, 'residualGain': 1.008}
        for text in ('$1,999.', '$999'):
            with self.subTest(text=text), patch('talk_server._playback_residual',
                                               return_value=(self.reference, evidence)):
                self.create.return_value = SimpleNamespace(text=text, segments=[])
                result = self.check(wav(self.spoken * .25))
                self.assertEqual(result['ignoreReason'], 'probable_playback_echo')
                self.assertFalse(result.get('inputConfirmed', False))

    def test_explicit_or_acoustically_distinct_numeric_correction_is_kept(self):
        spoken = 'An Accessible Queen is $199 per night.'
        evidence = {'correlation': .8851, 'residualEnergyFraction': .216511, 'residualGain': 1.008}
        self.assertFalse(server._is_correlated_numeric_echo('No, $1,999.', spoken, evidence))
        self.assertFalse(server._is_correlated_numeric_echo('$1,999.', spoken,
            {**evidence, 'correlation': .4}))
        self.assertFalse(server._is_correlated_numeric_echo('$1,999.', spoken,
            {**evidence, 'residualGain': 4.0}))

    def test_correlated_near_match_of_spoken_option_is_not_confirmed_as_caller(self):
        spoken = 'We have a Standard Queen for $189 per night, then a Deluxe King for $229.'
        server._remember_spoken(self.session, spoken)
        self.create.return_value = SimpleNamespace(text='We have a stand-up.', segments=[])
        evidence = {'correlation': .9671, 'residualEnergyFraction': .064738,
                    'offsetMs': -316.7, 'residualGain': 2.892}
        with patch('talk_server._playback_residual', return_value=(self.reference, evidence)):
            result = self.check(wav(self.spoken * .25))
        self.assertEqual(result['ignoreReason'], 'probable_playback_echo')
        self.assertFalse(result.get('inputConfirmed', False))
        self.agent.respond.assert_not_called()

    def test_quiet_caller_is_transcribed_from_clean_wav_and_keeps_full_text(self):
        caller = (Path(__file__).parent / 'test_audio/synthetic_no_16k.wav').read_bytes()
        voice = np.frombuffer(_decode_pcm(caller), dtype='<i2').astype(np.float32) / 32768
        voice = np.pad(voice, (0, max(0, len(self.spoken) - len(voice))))[:len(self.spoken)]
        mixed = wav(self.spoken * .3 + voice * .1)
        result = self.check(mixed)
        self.assertTrue(result['inputConfirmed'])
        self.assertEqual(result['transcript'], 'No.')
        uploaded = self.create.call_args.kwargs['file']
        self.assertEqual(uploaded.name, 'caller.wav')
        self.assertNotEqual(uploaded.getvalue(), mixed)
        self.assertGreater(classify_audio(uploaded.getvalue())['voicedMs'], 0)
        self.agent.respond.assert_not_called()

    def test_unknown_reference_preserves_original_caller_audio(self):
        caller = (Path(__file__).parent / 'test_audio/synthetic_no_16k.wav').read_bytes()
        self.assertTrue(self.check(caller, 'unknown')['inputConfirmed'])
        self.assertEqual(self.create.call_args.kwargs['file'].getvalue(), caller)

    def test_playback_reference_search_falls_back_when_reported_offset_misses(self):
        mixed = wav(self.spoken * .25)
        result = server._playback_residual(mixed, self.session, 'playing', 2000)
        self.assertIsNotNone(result)
        self.assertTrue(result[1]['offsetSearchFallback'])
        self.assertGreater(result[1]['correlation'], .99)

    def test_capture_through_bounds_echo_to_partial_playback_window(self):
        spoken = np.tile(self.spoken, 4)
        reference = wav(spoken)
        server._remember_audio(
            self.session, 'playing-through',
            {'audioBase64': base64.b64encode(reference).decode()},
        )
        start = 36000
        through = min(45200, len(spoken) - 100)
        microphone = np.zeros(2 * 16000, dtype=np.float32)
        microphone[:through - start] = spoken[start:through] * .2
        result = server._playback_residual(
            wav(microphone), self.session, 'playing-through', start / 16, through / 16,
        )
        self.assertIsNotNone(result)
        self.assertTrue(result[1]['truncatedPlayback'])
        self.assertGreater(result[1]['correlation'], .99)
        self.assertLess(result[1]['residualEnergyFraction'], .01)

    def test_interrupted_playback_feedback_bounds_reference_to_spoken_prefix(self):
        server._playback_feedback(self.session, 'playing', 'interrupted', 1, 700, 3000)
        microphone = np.zeros(2 * 16000, dtype=np.float32)
        echo = self.spoken[1600:11200] * .25
        microphone[:len(echo)] = echo
        result = server._playback_residual(wav(microphone), self.session, 'playing', 100)
        self.assertIsNotNone(result)
        self.assertTrue(result[1]['truncatedPlayback'])
        self.assertGreater(result[1]['correlation'], .99)

    def test_reset_releases_audio_and_sessions_keep_only_two_references(self):
        encoded = base64.b64encode(self.reference).decode()
        for number in range(3):
            server._remember_audio(self.session, str(number), {'audioBase64': encoded})
        self.assertEqual(list(server._playback_references[self.session]), ['1', '2'])
        server._reset_session(self.session)
        self.assertNotIn(self.session, server._playback_references)


if __name__ == '__main__':
    unittest.main()
