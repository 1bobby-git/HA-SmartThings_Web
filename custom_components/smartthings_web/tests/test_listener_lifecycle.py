"""Regressions using the actual runtime and a real asyncio timer."""
import unittest
from test_models import FakeClient, SmartThingsWebRuntime, inventory

class ListenerLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", inventory(10, 20, "2026-08-24T21:00:00Z"))
        self.runtime.listener_coalesce_ms = 60000
        self.observed = []
        self.listener = lambda: self.observed.append("first")

    async def asyncTearDown(self):
        if self.runtime._listener_flush_handle is not None:
            self.runtime._listener_flush_handle.cancel()
        self.runtime._pending_listeners.clear()

    def queue(self):
        self.runtime._notify_listeners()
        handle = self.runtime._listener_flush_handle
        self.assertIsNotNone(handle)
        self.assertFalse(handle.cancelled())
        return handle

    async def test_last_state_unsubscribe_cancels_pending_timer(self):
        unsubscribe = self.runtime.subscribe_state("dev_001", ("main", "switch", "switch"), self.listener)
        handle = self.queue()
        unsubscribe()
        unsubscribe()
        self.assertTrue(handle.cancelled())
        self.assertIsNone(self.runtime._listener_flush_handle)
        self.assertFalse(self.runtime._pending_listeners)
        self.runtime._flush_pending_listeners()
        self.assertEqual(self.observed, [])

    async def test_last_device_unsubscribe_cancels_pending_timer(self):
        unsubscribe = self.runtime.subscribe_device("dev_001", self.listener)
        handle = self.queue()
        unsubscribe()
        self.assertTrue(handle.cancelled())
        self.assertIsNone(self.runtime._listener_flush_handle)
        self.assertFalse(self.runtime._pending_listeners)

    async def test_global_unsubscribe_preserves_remaining_state_subscription(self):
        remove_global = self.runtime.subscribe(self.listener)
        remove_state = self.runtime.subscribe_state("dev_001", ("main", "switch", "switch"), self.listener)
        handle = self.queue()
        remove_global()
        self.assertIn(self.listener, self.runtime._pending_listeners)
        self.assertFalse(handle.cancelled())
        remove_state()
        self.assertTrue(handle.cancelled())
        self.assertFalse(self.runtime._pending_listeners)

    async def test_state_unsubscribe_preserves_other_device_subscription(self):
        remove_state = self.runtime.subscribe_state("dev_001", ("main", "switch", "switch"), self.listener)
        remove_device = self.runtime.subscribe_device("dev_002", self.listener)
        handle = self.queue()
        remove_state()
        self.assertIn(self.listener, self.runtime._pending_listeners)
        self.assertFalse(handle.cancelled())
        remove_device()
        self.assertTrue(handle.cancelled())
        self.assertFalse(self.runtime._pending_listeners)

    async def test_immediate_delivery_removes_older_batch_not_new_events(self):
        self.runtime.subscribe(self.listener)
        handle = self.queue()
        self.runtime._notify_listeners(immediate=True)
        self.assertEqual(self.observed, ["first"])
        self.assertTrue(handle.cancelled())
        self.assertIsNone(self.runtime._listener_flush_handle)
        self.runtime._flush_pending_listeners()
        self.assertEqual(self.observed, ["first"])
        self.runtime._notify_listeners(immediate=True)
        self.assertEqual(self.observed, ["first", "first"])

    async def test_immediate_delivery_preserves_unrelated_queued_callback(self):
        other = lambda: self.observed.append("second")
        self.runtime.subscribe_device("dev_001", self.listener)
        self.runtime.subscribe_device("dev_002", other)
        handle = self.queue()
        self.runtime._notify_listeners(device_ids={"dev_001"}, notify_global=False, immediate=True)
        self.assertEqual(self.observed, ["first"])
        self.assertEqual(self.runtime._pending_listeners, {other})
        self.assertIs(self.runtime._listener_flush_handle, handle)
        self.assertFalse(handle.cancelled())
        handle.cancel()
        self.runtime._flush_pending_listeners()
        self.assertEqual(self.observed, ["first", "second"])
