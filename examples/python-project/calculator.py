def discounted_total(prices, discount=0):
    if not 0 <= discount <= 1:
        raise ValueError("discount must be between zero and one")
    if any(price < 0 for price in prices):
        raise ValueError("prices must be non-negative")
    return round(sum(prices) * (1 - discount), 2)
