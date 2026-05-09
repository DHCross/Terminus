import unittest
import sys
import os
import importlib.util

# Add the root directory to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..')))

# Dynamically import the module since it has a hyphen in the path
spec = importlib.util.spec_from_file_location("rag_ingester", os.path.join(os.path.dirname(__file__), "rag_ingester.py"))
rag_ingester = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rag_ingester)

class TestBuildCompactOutput(unittest.TestCase):
    def setUp(self):
        self.full_metadata = {
            'source_id': 'src_123',
            'version_id': 'ver_456',
            'title': 'Test Document',
            'domain': 'general',
            'ingested_at': '2023-10-27T10:00:00Z',
            'supersedes_version_id': 'ver_123',
            'summary': 'A test document summary.',
            'state_store': {'some': 'state'},
            'chunks': [{}, {}],
            'delta_events': [
                {'section_heading': 'Intro', 'change_type': 'added', 'summary': 'Added intro'},
                {'section_heading': 'Body', 'change_type': 'modified', 'summary': 'Modified body'},
                {'section_heading': 'Unchanged', 'change_type': 'unchanged', 'summary': 'No change'},
                {'section_heading': 'Conclusion', 'change_type': 'added', 'summary': 'Added conclusion'},
                {'section_heading': 'Extra', 'change_type': 'added', 'summary': 'Added extra'},
            ],
            'anchor_notes': [
                {'text': 'Anchor 1'},
                {'text': 'Anchor 2'},
                {'text': 'Anchor 3'},
                {'text': 'Anchor 4'},
            ],
            'claim_notes': [
                {'claim_text': 'Claim 1'},
                {'claim_text': 'Claim 2'},
                {'claim_text': 'Claim 3'},
                {'claim_text': 'Claim 4'},
            ],
            'correction_events': [{}, {}, {}],
            'research_state': {
                'open_questions': ['Q1', 'Q2', 'Q3', 'Q4']
            },
            'continuity_cockpit': {
                'next_action': 'Do something'
            },
            'morning_summary': {
                'summary_id': 'sum_789',
                'suggested_next_step': 'Take a break'
            },
            'evaluation_signals': {'signal': 'green'}
        }

    def test_build_compact_output_full(self):
        output = rag_ingester.build_compact_output(self.full_metadata)

        self.assertEqual(output['output_mode'], 'compact')
        self.assertEqual(output['source_id'], 'src_123')
        self.assertEqual(output['version_id'], 'ver_456')
        self.assertEqual(output['title'], 'Test Document')
        self.assertEqual(output['domain'], 'general')
        self.assertEqual(output['ingested_at'], '2023-10-27T10:00:00Z')
        self.assertEqual(output['supersedes_version_id'], 'ver_123')
        self.assertEqual(output['summary'], 'A test document summary.')
        self.assertEqual(output['state_store'], {'some': 'state'})

        # Test changed_sections logic (filters unchanged, limits to 3)
        changed_sections = output['highlights']['changed_sections']
        self.assertEqual(len(changed_sections), 3)
        self.assertEqual(changed_sections[0]['section_heading'], 'Intro')
        self.assertEqual(changed_sections[1]['section_heading'], 'Body')
        self.assertEqual(changed_sections[2]['section_heading'], 'Conclusion')
        for section in changed_sections:
            self.assertNotEqual(section['change_type'], 'unchanged')

        # Test counts
        self.assertEqual(output['counts']['chunks'], 2)
        self.assertEqual(output['counts']['delta_events'], 5)
        self.assertEqual(output['counts']['anchor_notes'], 4)
        self.assertEqual(output['counts']['claim_notes'], 4)
        self.assertEqual(output['counts']['correction_events'], 3)

        # Test highlights slicing and mapping
        self.assertEqual(output['highlights']['promoted_anchors'], ['Anchor 1', 'Anchor 2', 'Anchor 3'])
        self.assertEqual(output['highlights']['new_claims'], ['Claim 1', 'Claim 2', 'Claim 3'])
        self.assertEqual(output['highlights']['open_questions'], ['Q1', 'Q2', 'Q3'])
        self.assertEqual(output['highlights']['next_action'], 'Do something')

        # Test morning_summary mapping
        self.assertEqual(output['morning_summary']['summary_id'], 'sum_789')
        self.assertEqual(output['morning_summary']['suggested_next_step'], 'Take a break')

        # Test evaluation_signals
        self.assertEqual(output['evaluation_signals'], {'signal': 'green'})

    def test_build_compact_output_minimal(self):
        minimal_metadata = {
            'source_id': 'src_123',
            'version_id': 'ver_456',
            'title': 'Test Document',
            'domain': 'general',
            'ingested_at': '2023-10-27T10:00:00Z',
            'supersedes_version_id': None,
            'summary': 'Short.',
            'chunks': [],
            'delta_events': [],
            'anchor_notes': [],
            'claim_notes': [],
            'correction_events': [],
            'research_state': {'open_questions': []},
            'continuity_cockpit': {'next_action': None},
            'morning_summary': {'summary_id': 'id', 'suggested_next_step': None},
            'evaluation_signals': {}
        }
        output = rag_ingester.build_compact_output(minimal_metadata)

        self.assertIsNone(output.get('state_store'))
        self.assertEqual(output['highlights']['changed_sections'], [])
        self.assertEqual(output['counts']['chunks'], 0)
        self.assertEqual(output['highlights']['promoted_anchors'], [])
        self.assertEqual(output['highlights']['new_claims'], [])
        self.assertEqual(output['highlights']['open_questions'], [])

if __name__ == '__main__':
    unittest.main()
