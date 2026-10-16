# Attribution and source boundaries

This project's original code and documentation are distributed under the [MIT License](LICENSE). The project name and contributor attribution do not imply affiliation with Cocos or endorsement by Cocos.

## Reference project

The architecture and user workflows were studied alongside [DaxianLee/cocos-mcp-server](https://github.com/DaxianLee/cocos-mcp-server/tree/a5db895b3299dccd78979ca0268193e4b6ebf037), package 1.5.4, commit `a5db895b3299dccd78979ca0268193e4b6ebf037`. Its source inventory and limitations are documented in [COMPARISON.md](docs/COMPARISON.md).

That snapshot has no standalone LICENSE; its README restricts commercial use and derivative code. This project's MIT license does not change those terms or grant rights to that repository. Do not import reference code without permission that covers the intended distribution. The comparison inventory is analysis metadata, not a bundled copy of that implementation.

An [initial source overlap review](analysis/source-overlap-review.json) records the local source hashes and an exact normalized multi-line comparison against the pinned reference. It found no matching windows in the stated scope. This limited screen cannot detect transformed copies or reconstruct earlier authorship history; it does not replace provenance review.

## Creator installation and generated fixtures

Compatibility work used locally installed Creator packages, message manifests, runtime observations and disposable test projects. Extracted editor implementations and the editor packages are excluded from distribution. The fixture helper reads a scene template from the user's own Creator installation at runtime; no extracted template is shipped here. Creator and its engine remain subject to their own terms.

## Dependencies and contributions

Runtime dependencies are recorded in [package-lock.json](package-lock.json). They retain their own licenses and notices; MIT does not replace those terms. Installed dependency license files accompany the installed packages.

Contribute only material you can license under this project's terms. Keep source attributions and permission records when adding third-party material. A source similarity scan or passing test suite alone does not establish legal provenance.
