import unittest

from calculator import discounted_total


class CalculatorTests(unittest.TestCase):
    def test_discount(self):
        self.assertEqual(discounted_total([10, 20], 0.1), 27)

    def test_invalid_inputs(self):
        with self.assertRaises(ValueError):
            discounted_total([10], 2)
        with self.assertRaises(ValueError):
            discounted_total([-1])


if __name__ == "__main__":
    unittest.main()
