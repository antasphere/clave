# Checkout: address validation

**Goal**: no order draft is created with an address the carrier will reject.

## Scope

1. Validate the shipping address in the checkout form before submit
2. Share the same rules with the `/api/orders` route
3. Show errors inline, under each field, and move focus to the first one

## Rules

- **Street**: required, trimmed, 3 to 120 characters
- **City**: required, trimmed
- **Postal code**: matches the selected country's format
- **Country**: one of the countries we ship to

## Out of scope

- Address autocomplete (next sprint)
- Validating billing addresses

## Done when

- [x] `validateAddress()` covers the four rules, with tests
- [ ] The verifier signs off on the branch
- [ ] Merged and deployed to the staging shop
