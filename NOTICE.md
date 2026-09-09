# Third-party materials

Original on-brand code and documentation are distributed under the MIT license.
That license does not replace the licenses or rights of third-party materials.

- **Water Lilies:** Claude Monet, 1906, Art Institute of Chicago. The included
  image is identified by the institution as CC0 Public Domain Designation.
  [PROVENANCE.md](examples/inspiration/water-lilies/PROVENANCE.md) records the
  exact source, acquisition, attribution, and reviewed bytes. README captures
  showing the painting use that same image.
- **Website benchmark evidence:** screenshots and extracted observations under
  `docs/findings/` and `test/fixtures/extraction/` include third-party website
  material. The relevant source URLs and capture provenance are recorded in
  [benchmark/FIXTURES.md](benchmark/FIXTURES.md), the extraction reports, and the
  fixture JSON. Those websites' artwork, logos, text, and other content are not
  relicensed under MIT by this repository.
- **Dependencies:** third-party packages retain their respective licenses.
  `package-lock.json` records the dependency versions and available license metadata.
- **README diagrams:** the light/dark diagram style follows the MIT-licensed
  [skill-mesh](https://github.com/aberson/skill-mesh) diagrams; the on-brand
  workflow content and layouts are maintained here.

The extractor fingerprints website font stacks and generates references to
lookalikes; it does not include downloaded source webfont binaries.
