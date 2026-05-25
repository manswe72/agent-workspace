# bash completion for agent-workspace setup.sh
# Triggers when invoked as ./setup.sh — registered against the basename.
_agent_workspace_setup_sh() {
  local cur prev opts
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  opts="--target --systemd --non-interactive \
        --yes --uninstall -h --help"

  case "$prev" in
    --target)
      compopt -o dirnames 2>/dev/null
      COMPREPLY=( $(compgen -d -- "$cur") )
      return 0
      ;;
  esac
  if [[ "$cur" == --target=* ]]; then
    compopt -o dirnames 2>/dev/null
    COMPREPLY=( $(compgen -d -- "${cur#--target=}") )
    return 0
  fi
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
  fi
}
complete -F _agent_workspace_setup_sh setup.sh
