TYPE_TO_BYTES = [
    'annotated_type',
    'annotation',
    'annotation_argument_list',
    'annotation_type_body',
    'annotation_type_declaration',
    'annotation_type_declaration_ref',
    'annotation_type_element_declaration',
    'annotation_type_element_declaration_ref',
    'argument_list',
    'array_access',
    'array_creation_expression',
    'array_initializer',
    'array_type',
    'assert_statement',
    'assignment_expression',
    'asterisk',
    'binary_expression',
    'binary_integer_literal',
    'block',
    'boolean_type',
    'break_statement',
    'cast_expression',
    'catch_clause',
    'catch_formal_parameter',
    'catch_formal_parameter_ref',
    'catch_type',
    'character_literal',
    'class_body',
    'class_declaration',
    'class_declaration_ref',
    'class_literal',
    'comment',
    'constant_declaration',
    'constant_declaration_ref',
    'constructor_body',
    'constructor_declaration',
    'constructor_declaration_ref',
    'continue_statement',
    'decimal_floating_point_literal',
    'decimal_integer_literal',
    'declaration',
    'dimensions',
    'dimensions_expr',
    'do_statement',
    'element_value_array_initializer',
    'element_value_pair',
    'enhanced_for_statement',
    'enhanced_for_statement_ref',
    'enum_body',
    'enum_body_declarations',
    'enum_constant',
    'enum_declaration',
    'enum_declaration_ref',
    'explicit_constructor_invocation',
    'expression',
    'expression_statement',
    'extends_interfaces',
    'f_alternative',
    'f_arguments',
    'f_array',
    'f_body',
    'f_child',
    'f_condition',
    'f_consequence',
    'f_constructor',
    'f_declarator',
    'f_dimensions',
    'f_element',
    'f_field',
    'f_index',
    'f_init',
    'f_interfaces',
    'f_key',
    'f_left',
    'f_name',
    'f_object',
    'f_operand',
    'f_operator',
    'f_parameters',
    'f_resources',
    'f_right',
    'f_scope',
    'f_superclass',
    'f_type',
    'f_type_arguments',
    'f_type_parameters',
    'f_update',
    'f_value',
    'false',
    'field_access',
    'field_declaration',
    'field_declaration_ref',
    'finally_clause',
    'floating_point_type',
    'for_statement',
    'formal_parameter',
    'formal_parameter_ref',
    'formal_parameters',
    'generic_type',
    'hex_floating_point_literal',
    'hex_integer_literal',
    'identifier',
    'if_statement',
    'import_declaration',
    'import_declaration_ref',
    'inferred_parameters',
    'instanceof_expression',
    'integral_type',
    'interface_body',
    'interface_declaration',
    'interface_declaration_ref',
    'interface_type_list',
    'labeled_statement',
    'lambda_expression',
    'literal',
    'local_variable_declaration',
    'local_variable_declaration_ref',
    'marker_annotation',
    'method_declaration',
    'method_declaration_ref',
    'method_invocation',
    'method_reference',
    'modifiers',
    'module_body',
    'module_declaration',
    'module_declaration_ref',
    'module_directive',
    'null_literal',
    'object_creation_expression',
    'octal_integer_literal',
    'package_declaration',
    'package_declaration_ref',
    'parenthesized_expression',
    'primary_expression',
    'program',
    'receiver_parameter',
    'requires_modifier',
    'resource',
    'resource_specification',
    'return_statement',
    'scoped_identifier',
    'scoped_type_identifier',
    'simple_type',
    'spread_parameter',
    'statement',
    'static_initializer',
    'string_literal',
    'super',
    'super_interfaces',
    'superclass',
    'switch_block',
    'switch_label',
    'switch_statement',
    'synchronized_statement',
    'ternary_expression',
    'this',
    'throw_statement',
    'throws',
    'true',
    'try_statement',
    'try_with_resources_statement',
    'type',
    'type_arguments',
    'type_bound',
    'type_identifier',
    'type_parameter',
    'type_parameters',
    'unannotated_type',
    'unary_expression',
    'update_expression',
    'variable_declarator',
    'variable_declarator_ref',
    'void_type',
    'while_statement',
    'wildcard'
]

def type_to_bytes(the_type):
    return TYPE_TO_BYTES.index(the_type).to_bytes(2, byteorder='little')

def type_to_idx(the_type):
    return TYPE_TO_BYTES.index(the_type)

def decode_path(path):
    idx = 0
    result = []
    while idx < len(path):
        gid_bytes = path[idx:idx+8]
        did_bytes = path[idx+8:idx+16]
        nid_bytes = path[idx+16:idx+24]
        spos_bytes = path[idx+24:idx+28]
        epos_bytes = path[idx+28:idx+32]
        label_bytes = path[idx+32:idx+34]
        field_bytes = path[idx+34:idx+36]
        index_bytes = path[idx+36:idx+38]

        try:
            result.append((
                int.from_bytes(gid_bytes, signed=True, byteorder="little"),
                (
                    int.from_bytes(spos_bytes, signed=False, byteorder="little"),
                    int.from_bytes(epos_bytes, signed=False, byteorder="little")
                ),
                (
                    TYPE_TO_BYTES[int.from_bytes(label_bytes, signed=False, byteorder="little")] + ((
                        '.' + TYPE_TO_BYTES[int.from_bytes(field_bytes, signed=False, byteorder="little")] + '['
                        + str(int.from_bytes(index_bytes, signed=False, byteorder="little")) + ']'
                    ) if idx + 40 < len(path) else '')
                )
            ))
        except:
            pass

        idx += 40
    
    return result
