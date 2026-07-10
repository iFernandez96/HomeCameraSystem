from wedge_diagnostics import (
    count_argus_pending,
    parse_free_available_mb,
    parse_nvargus_rss_kb,
)


def test_Given_multiple_process_rows_When_parsed_Then_largest_rss_is_returned():
    text = " 10 1234 00:01 nvargus-daemon\n 11 9876 00:02 nvargus-daemon\n"
    assert parse_nvargus_rss_kb(text) == 9876.0


def test_Given_free_output_When_parsed_Then_available_memory_is_returned():
    text = "Mem: 1980 1000 100 20 200 660\n"
    assert parse_free_available_mb(text) == 660.0


def test_Given_mixed_case_argus_signatures_When_counted_Then_both_are_found():
    text = "Argus OverFlow happened\nTOO MANY PENDING EVENTS\nordinary line"
    assert count_argus_pending(text) == 2.0
