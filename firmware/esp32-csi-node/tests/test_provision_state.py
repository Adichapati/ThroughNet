"""Tests for provision.py's additive-by-default merge behaviour (#391, #574)."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import unittest

# Allow `python -m unittest` from anywhere in the repo.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import provision  # noqa: E402  — sibling import after sys.path tweak


def _mk_args(**overrides) -> argparse.Namespace:
    """Build a Namespace with every mergeable attr set to None unless overridden."""
    base = {name: None for name in provision.MERGEABLE_ATTRS}
    base.update(overrides)
    return argparse.Namespace(**base)


class TestStateFile(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="provision-state-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_load_state_empty_when_missing(self):
        self.assertEqual(provision.load_state("COM7", self.dir), {})

    def test_save_then_load_roundtrip(self):
        provision.save_state("COM7", self.dir, {"ssid": "x", "password": "y"})
        self.assertEqual(
            provision.load_state("COM7", self.dir),
            {"ssid": "x", "password": "y"},
        )

    def test_save_creates_per_port_files(self):
        provision.save_state("COM7", self.dir, {"ssid": "a"})
        provision.save_state("/dev/ttyUSB0", self.dir, {"ssid": "b"})
        self.assertEqual(provision.load_state("COM7", self.dir), {"ssid": "a"})
        self.assertEqual(provision.load_state("/dev/ttyUSB0", self.dir), {"ssid": "b"})

    def test_load_state_handles_corrupt_json(self):
        path = provision._state_path_for("COM7", self.dir)
        os.makedirs(self.dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not valid json")
        # Should warn but not raise.
        self.assertEqual(provision.load_state("COM7", self.dir), {})


class TestMerge(unittest.TestCase):
    def test_cli_wins_over_prior(self):
        args = _mk_args(ssid="new-ssid")
        prior = {"ssid": "old-ssid", "password": "abc"}
        merged = provision.merge_state_into_args(args, prior)
        self.assertEqual(args.ssid, "new-ssid")  # CLI value preserved
        self.assertEqual(args.password, "abc")    # filled from prior
        self.assertEqual(merged["ssid"], "new-ssid")
        self.assertEqual(merged["password"], "abc")

    def test_prior_fills_missing_cli(self):
        args = _mk_args()  # all None
        prior = {
            "ssid": "MyWiFi",
            "password": "secret",
            "target_ip": "192.168.1.20",
            "node_id": 3,
        }
        merged = provision.merge_state_into_args(args, prior)
        self.assertEqual(args.ssid, "MyWiFi")
        self.assertEqual(args.password, "secret")
        self.assertEqual(args.target_ip, "192.168.1.20")
        self.assertEqual(args.node_id, 3)
        for key, val in prior.items():
            self.assertEqual(merged[key], val)

    def test_partial_invocation_does_not_drop_unrelated_keys(self):
        # The exact #391 scenario: user previously provisioned WiFi, now adds
        # only --seed-url. Old behaviour wiped SSID. New behaviour keeps it.
        args = _mk_args(seed_url="http://10.1.10.236")
        prior = {
            "ssid": "ruv.net",
            "password": "<secret>",
            "target_ip": "192.168.1.20",
        }
        merged = provision.merge_state_into_args(args, prior)
        self.assertEqual(args.ssid, "ruv.net")
        self.assertEqual(args.password, "<secret>")
        self.assertEqual(args.target_ip, "192.168.1.20")
        self.assertEqual(args.seed_url, "http://10.1.10.236")
        # And the on-disk merged dict carries all four keys.
        self.assertEqual(set(merged.keys()),
                         {"ssid", "password", "target_ip", "seed_url"})

    def test_empty_prior_is_noop(self):
        args = _mk_args(ssid="x")
        merged = provision.merge_state_into_args(args, {})
        self.assertEqual(merged, {"ssid": "x"})

    def test_falsy_but_not_none_cli_value_overrides_prior(self):
        # node_id=0 is a legal value; must NOT be replaced by prior["node_id"]=5.
        args = _mk_args(node_id=0)
        prior = {"node_id": 5}
        merged = provision.merge_state_into_args(args, prior)
        self.assertEqual(args.node_id, 0)
        self.assertEqual(merged["node_id"], 0)


class TestStatePathSanitization(unittest.TestCase):
    def test_slashes_in_port_are_safe(self):
        path = provision._state_path_for("/dev/ttyUSB0", "/tmp/x")
        # Must not contain a raw slash in the basename
        self.assertNotIn("/", os.path.basename(path))

    def test_windows_com_port_is_safe(self):
        path = provision._state_path_for("COM7", "/tmp/x")
        self.assertTrue(path.endswith("COM7.json"))


class TestAutoAssignment(unittest.TestCase):
    """ROADMAP R2 — fleet-aware --auto role/node_id/filter_mac assignment."""

    def test_next_free_node_id_empty_fleet(self):
        self.assertEqual(provision._next_free_node_id([]), 1)

    def test_next_free_node_id_skips_used_and_fills_gaps(self):
        states = [{"node_id": 1}, {"node_id": 3}]
        self.assertEqual(provision._next_free_node_id(states), 2)
        states.append({"node_id": 2})
        self.assertEqual(provision._next_free_node_id(states), 4)

    def test_find_tx_mac(self):
        states = [
            {"role": "rx", "node_id": 2},
            {"role": "tx", "node_id": 1, "wifi_mac": "14:c1:9f:3a:06:f8"},
        ]
        self.assertEqual(provision._find_tx_mac(states), "14:c1:9f:3a:06:f8")
        self.assertIsNone(provision._find_tx_mac([{"role": "rx", "node_id": 2}]))

    def test_parse_mac(self):
        self.assertEqual(
            provision.parse_mac("MAC: 14:C1:9F:3A:06:F8\n"), "14:c1:9f:3a:06:f8"
        )
        self.assertIsNone(provision.parse_mac("no mac here"))
        self.assertIsNone(provision.parse_mac(None))

    def test_first_board_becomes_tx(self):
        args = _mk_args()
        merged = {}
        provision.apply_auto_assignment(args, merged, [])
        self.assertEqual(args.role, "tx")
        self.assertEqual(args.node_id, 1)
        self.assertEqual(merged["role"], "tx")
        self.assertEqual(merged["node_id"], 1)

    def test_second_board_becomes_rx_locked_to_tx(self):
        fleet = [{"role": "tx", "node_id": 1, "wifi_mac": "14:c1:9f:3a:06:f8"}]
        args = _mk_args()
        merged = {}
        provision.apply_auto_assignment(args, merged, fleet)
        self.assertEqual(args.role, "rx")
        self.assertEqual(args.node_id, 2)
        self.assertEqual(args.filter_mac, "14:c1:9f:3a:06:f8")
        self.assertEqual(merged["filter_mac"], "14:c1:9f:3a:06:f8")

    def test_explicit_values_win_over_auto(self):
        fleet = [{"role": "tx", "node_id": 1, "wifi_mac": "aa:bb:cc:dd:ee:ff"}]
        args = _mk_args(role="rx", node_id=7, filter_mac="11:22:33:44:55:66")
        merged = {}
        provision.apply_auto_assignment(args, merged, fleet)
        self.assertEqual(args.role, "rx")
        self.assertEqual(args.node_id, 7)
        self.assertEqual(args.filter_mac, "11:22:33:44:55:66")

    def test_rx_without_recorded_tx_mac_leaves_filter_unset(self):
        fleet = [{"role": "tx", "node_id": 1}]  # TX present but MAC not recorded yet
        args = _mk_args()
        merged = {}
        notes = provision.apply_auto_assignment(args, merged, fleet)
        self.assertEqual(args.role, "rx")
        self.assertIsNone(args.filter_mac)
        self.assertTrue(any("filter_mac" in n for n in notes))


if __name__ == "__main__":
    unittest.main()
