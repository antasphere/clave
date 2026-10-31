import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('relay_image_ci', Path(__file__).with_name('relay-image-ci.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class ImagePredicates(unittest.TestCase):
    def setUp(self):
        self.iid = 'sha256:' + 'a' * 64
        self.sha = 'b' * 40
        self.image = {'Id': self.iid, 'Os': 'linux', 'Architecture': 'amd64',
                      'Config': {'Labels': {'org.opencontainers.image.revision': self.sha}}}
        self.metadata = {'containerimage.config.digest': self.iid,
                         'containerimage.digest': 'sha256:' + 'c' * 64,
                         'containerimage.descriptor': {'digest': 'sha256:' + 'c' * 64,
                          'mediaType': 'application/vnd.oci.image.manifest.v1+json'}}

    def test_exact_identity_and_platform(self):
        ci.validate_image(self.iid, self.image, self.metadata, self.sha)

    def test_actual_checkout_and_ordered_parents_are_required(self):
        merge, tree, head, base = (x * 40 for x in ['a', 'b', 'c', 'd'])
        ci.validate_source(merge, tree, [base, head], merge, head, base)
        for parents, event in [([head, base], merge), ([base, head], head)]:
            with self.assertRaises(AssertionError):
                ci.validate_source(merge, tree, parents, event, head, base)

    def test_wrong_platform_cannot_pass(self):
        self.image['Architecture'] = 'arm64'
        with self.assertRaises(AssertionError):
            ci.validate_image(self.iid, self.image, self.metadata, self.sha)

    def test_head_label_is_not_a_substitute_for_actual_tested_merge(self):
        self.image['Config']['Labels']['org.opencontainers.image.revision'] = 'd' * 40
        with self.assertRaises(AssertionError):
            ci.validate_image(self.iid, self.image, self.metadata, self.sha)

    def test_digest_mismatch_cannot_pass(self):
        for key in ['containerimage.config.digest', 'containerimage.digest']:
            changed = copy.deepcopy(self.metadata)
            changed[key] = 'sha256:' + 'd' * 64
            with self.assertRaises(AssertionError):
                ci.validate_image(self.iid, self.image, changed, self.sha)

    def test_healthy_and_unauthorized(self):
        ci.validate_smoke({'status': 'live', 'machines': 0, 'online': 0}, 401)

    def test_successful_unauthenticated_listing_fails_gate(self):
        with self.assertRaises(AssertionError):
            ci.validate_smoke({'status': 'live', 'machines': 0, 'online': 0}, 200)

    def test_unhealthy_body_fails_gate(self):
        with self.assertRaises(AssertionError):
            ci.validate_smoke({'status': 'live', 'machines': 1, 'online': 0}, 401)

    def test_embedded_provenance_must_match_not_just_exist(self):
        expected = {'workspaceLockSha256': 'a' * 64,
                    'packages': [{'version': '3.22.1', 'integrity': 'locked'}]}
        ci.validate_dependencies(copy.deepcopy(expected), expected)
        changed = copy.deepcopy(expected)
        changed['packages'][0]['version'] = '3.22.0'
        with self.assertRaises(AssertionError):
            ci.validate_dependencies(changed, expected)

    def test_cleanup_ownership_checks_id_name_and_label(self):
        cid = 'a' * 64
        value = {'Id': cid, 'Name': '/owned', 'Config': {'Labels': {ci.OWNER_LABEL: 'owned'}}}
        self.assertEqual(ci.validate_owned_container(value, 'owned', cid), cid)
        for key in ['id', 'name', 'label']:
            changed = copy.deepcopy(value)
            if key == 'id': changed['Id'] = 'b' * 64
            if key == 'name': changed['Name'] = '/foreign'
            if key == 'label': changed['Config']['Labels'][ci.OWNER_LABEL] = 'foreign'
            with self.assertRaises(AssertionError):
                ci.validate_owned_container(changed, 'owned', cid)

    def test_cleanup_never_removes_a_foreign_label(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'
        }):
            out = Path(directory)
            (out / 'create-attempted').write_text('attempted')
            (out / 'container-id').write_text('a' * 64)
            foreign = {'Id': 'a' * 64, 'Name': '/' + ci.owner(),
                       'Config': {'Labels': {ci.OWNER_LABEL: 'foreign'}}}
            with patch.object(ci, 'evidence', return_value=out), patch.object(
                ci, 'run', return_value=json.dumps([foreign])
            ) as commands:
                with self.assertRaises(AssertionError):
                    ci.cleanup()
                self.assertEqual(commands.call_count, 1)
                self.assertNotIn('rm', commands.call_args.args[0])
            self.assertFalse(json.loads((out / 'cleanup.json').read_text())['removed'])

    def test_cleanup_removes_only_validated_id_and_records_absence(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'GITHUB_RUN_ID': '1', 'GITHUB_RUN_ATTEMPT': '1'
        }):
            out = Path(directory)
            cid = 'a' * 64
            (out / 'create-attempted').write_text('attempted')
            (out / 'container-id').write_text(cid)
            owned = {'Id': cid, 'Name': '/' + ci.owner(),
                     'Config': {'Labels': {ci.OWNER_LABEL: ci.owner()}}}
            def response(argv, **kwargs):
                if 'logs' in argv:
                    return subprocess.CompletedProcess(argv, 0)
                return subprocess.CompletedProcess(argv, 1, '', 'Error: No such container: ' + cid)
            with patch.object(ci, 'evidence', return_value=out), patch.object(
                ci, 'run', side_effect=[json.dumps([owned]), cid]
            ) as commands, patch.object(ci.subprocess, 'run', side_effect=response):
                ci.cleanup()
                self.assertEqual(commands.call_args_list[-1].args[0],
                                 ['docker', 'container', 'rm', '--force', '--volumes', cid])
            self.assertEqual(json.loads((out / 'cleanup.json').read_text())['containerId'], cid)


if __name__ == '__main__':
    unittest.main()
