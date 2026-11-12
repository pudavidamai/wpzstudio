# Gemfile for the GitHub Pages build.
#
# GitHub Pages builds this site with the `github-pages` gem (v232), which
# pins Jekyll 3.10.0, Liquid 4.0.4 and the official plugin set. Pinning the
# same versions locally means a build that works here also works there.
#
#   bundle install
#   bundle exec jekyll build --config _config.yml,tools/_config.strict.yml
#
# The strict config matters: GitHub Pages sets `liquid.error_mode: strict`,
# so a Liquid error is fatal in production while a plain local build only
# warns. Use the strict config for any build you intend to deploy.

source "https://rubygems.org"

gem "github-pages", "232", group: :jekyll_plugins
