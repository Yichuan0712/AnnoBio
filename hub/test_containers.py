"""Concurrent workspace requests share startup and obey the global capacity cap."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


class ContainerStartupTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('hub_container_startup', Path(__file__).with_name('containers.py'))
        self.module = importlib.util.module_from_spec(spec)
        self.db = SimpleNamespace(upsert_container=mock.Mock())
        with mock.patch.dict('sys.modules', {'db': self.db,
                'hosted_model': SimpleNamespace(account_token=lambda user: f'token-{user}')}):
            spec.loader.exec_module(self.module)

    def test_same_user_waits_for_one_startup_to_be_ready(self):
        container = SimpleNamespace(status='exited')
        container.start = mock.Mock(side_effect=lambda: setattr(container, 'status', 'running'))
        client = SimpleNamespace(containers=SimpleNamespace(get=mock.Mock(return_value=container)))
        entered = threading.Event()
        release = threading.Event()

        def ready(_name):
            entered.set()
            self.assertTrue(release.wait(2))

        with mock.patch.object(self.module, 'client', return_value=client), \
                mock.patch.object(self.module, '_wait_until_ready', side_effect=ready), \
                ThreadPoolExecutor(max_workers=2) as workers:
            first = workers.submit(self.module.ensure_running, 1)
            try:
                self.assertTrue(entered.wait(1))
                second = workers.submit(self.module.ensure_running, 1)
                self.assertFalse(second.done())
            finally:
                release.set()
            self.assertEqual(first.result(), 'promptstudio-user-1')
            self.assertEqual(second.result(), 'promptstudio-user-1')
        container.start.assert_called_once()

    def test_different_users_cannot_create_past_capacity(self):
        module = self.module
        docker_containers = SimpleNamespace(
            get=mock.Mock(side_effect=module.NotFound('missing')), run=mock.Mock())
        client = SimpleNamespace(containers=docker_containers)
        barrier = threading.Barrier(2)

        def absent(_name):
            barrier.wait(timeout=2)
            raise module.NotFound('missing')

        docker_containers.get.side_effect = absent
        with mock.patch.object(module, 'client', return_value=client), \
                mock.patch.object(module, 'MAX_ACTIVE_CONTAINERS', '1'), \
                mock.patch.object(module, '_count_running_backend_containers', side_effect=lambda: docker_containers.run.call_count), \
                mock.patch.object(module, '_wait_until_ready'), \
                ThreadPoolExecutor(max_workers=2) as workers:
            futures = [workers.submit(module.ensure_running, user) for user in (1, 2)]
            successes = 0
            rejected = 0
            for future in futures:
                try:
                    future.result()
                    successes += 1
                except module.CapacityExceeded:
                    rejected += 1
        self.assertEqual((successes, rejected), (1, 1))
        docker_containers.run.assert_called_once()


if __name__ == '__main__':
    unittest.main()
